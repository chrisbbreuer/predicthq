import type { Database } from '../../Support/db'
import type { VenueMarket } from '../prediction-markets/provider'
import type { TradingClient, VenueOrder, VenuePosition } from './venue'
import { log } from '@stacksjs/logging'
import { KalshiProvider } from '../prediction-markets/kalshi'
import { PolymarketProvider } from '../prediction-markets/polymarket'
import { clientFor, revokeAccount } from './execute'
import { isAuthFailure, VenueError } from './venue'

/**
 * Asking the venue what the account actually holds.
 *
 * `sync.ts` reconciles the orders *we* placed, one at a time, by their
 * venue id. That is the right basis for our own book — a position we
 * booked from a fill we watched — and it is blind to everything else on
 * the account. A user who has traded Kalshi by hand for a year holds
 * contracts this application never opened, and until something asks the
 * venue for the whole picture, a page titled "your positions" tells them
 * they have none.
 *
 * So this is the other half: per account, one balance read, one position
 * read, one resting-order read, mirrored into `venue_positions` and
 * `venue_orders`. Both are snapshots, replaced in full on every pass, so
 * a position closed at the venue disappears here on the next pass rather
 * than lingering as a holding the user does not have.
 *
 * Nothing downstream sizes an order off these tables. A mirror of an
 * external system is exactly the wrong thing to let authorize spending:
 * risk limits keep reading `exchange_positions`, which is built from
 * fills we reconciled ourselves.
 */

/** How the market metadata behind a venue ticker is fetched. */
type MarketLookup = (venue: string, externalIds: string[]) => Promise<VenueMarket[]>

export interface AccountSyncOptions {
  /** Limit the pass to one user's accounts. Omitted, every account syncs. */
  userId?: number
  now?: Date
  /**
   * How to obtain a client for an account's sealed credentials, and how
   * to look up market metadata. Injectable for the same reason the order
   * reconciler injects its client: every branch here is about what a
   * venue said, and a test that cannot make a venue say something is a
   * test of nothing.
   */
  clientFor?: (sealedCredentials: string) => Promise<TradingClient>
  marketsFor?: MarketLookup
}

export interface AccountSyncSummary {
  /** Accounts we reached and mirrored. */
  synced: number
  /** Position rows written across those accounts. */
  positions: number
  /** Resting-order rows written across those accounts. */
  orders: number
  /** Accounts the venue would not answer for. */
  unreachable: number
}

interface AccountRow {
  id: number
  user_id: number
  venue: string
  credentials: string
  status: string
}

/** Public metadata, by venue. No credentials: these are open endpoints. */
const PROVIDERS = {
  kalshi: () => new KalshiProvider(),
  polymarket: () => new PolymarketProvider(),
} as const

async function fetchMarkets(venue: string, externalIds: string[]): Promise<VenueMarket[]> {
  const provider = PROVIDERS[venue as keyof typeof PROVIDERS]
  if (!provider || externalIds.length === 0)
    return []

  return await provider().fetchMarketsByIds(externalIds)
}

/**
 * Mirror every connected account, or one user's.
 *
 * Per-account isolated: a venue rejecting one account must not stop the
 * others, or one dead credential freezes the portfolio page for everyone
 * on that venue.
 */
export async function syncAccounts(db: Database, options: AccountSyncOptions = {}): Promise<AccountSyncSummary> {
  const now = options.now ?? new Date()
  const stamp = now.toISOString()
  const openClient = options.clientFor ?? clientFor
  const marketsFor = options.marketsFor ?? fetchMarkets
  const summary: AccountSyncSummary = { synced: 0, positions: 0, orders: 0, unreachable: 0 }

  const accounts = await db.prepare<AccountRow>(`
    SELECT id, user_id, venue, credentials, status
    FROM exchange_accounts
    WHERE status = 'active'${options.userId ? ' AND user_id = ?' : ''}
    ORDER BY id
  `).all(...(options.userId ? [options.userId] : []))

  for (const account of accounts) {
    try {
      const client = await openClient(account.credentials)
      await syncOne(db, client, account, stamp, marketsFor, summary)
      summary.synced++
    }
    catch (error) {
      summary.unreachable++

      // Credentials the venue rejects once it will reject every time, so
      // the account is marked rather than retried each minute. The error
      // is also written to the account row: a portfolio page that has
      // stopped updating has to be able to say why.
      if (error instanceof VenueError && isAuthFailure(error.status)) {
        await revokeAccount(db, account.id, message(error))
        log.warn(`[trading] ${account.venue} rejected our credentials; account ${account.id} marked revoked`)
        continue
      }

      await noteFailure(db, account.id, message(error), stamp)
      log.warn(`[trading] could not sync account ${account.id}: ${message(error)}`)
    }
  }

  return summary
}

/**
 * One account: balance, positions, resting orders.
 *
 * The balance read comes first because it is also the credential health
 * check — the cheapest call that proves the key still works — and there
 * is no point mirroring holdings we are about to be told we cannot see.
 */
async function syncOne(
  db: Database,
  client: TradingClient,
  account: AccountRow,
  stamp: string,
  marketsFor: MarketLookup,
  summary: AccountSyncSummary,
): Promise<void> {
  const balance = await client.fetchBalance()
  const positions = await client.fetchPositions()

  /*
   * Resting orders are optional twice over: optional on the client, for a
   * venue whose API cannot list orders it was not asked about, and
   * optional in effect, because a failure here must not cost the user the
   * positions we have already read. Holdings are the point of this pass;
   * what is resting beside them is worth strictly less than they are.
   *
   * An auth failure is the exception and is left to propagate — that is
   * not this endpoint being unavailable, it is the account being gone.
   */
  let orders: VenueOrder[] = []
  if (client.fetchOpenOrders) {
    try {
      orders = await client.fetchOpenOrders()
    }
    catch (error) {
      if (error instanceof VenueError && isAuthFailure(error.status))
        throw error

      log.warn(`[trading] could not list resting orders for account ${account.id}: ${message(error)}`)
    }
  }

  const marketIds = await resolveMarkets(
    db,
    account.venue,
    [...new Set([...positions.map(p => p.marketExternalId), ...orders.map(o => o.marketExternalId)])],
    marketsFor,
    stamp,
  )

  await db.prepare(`
    UPDATE exchange_accounts
    SET balance = ?, last_error = '', last_synced_at = ?, updated_at = ?
    WHERE id = ?
  `).run(balance.available, stamp, stamp, account.id)

  /*
   * Replace the account's rows outright rather than upserting and then
   * sweeping what kept an older stamp. The sweep is the tempting version
   * and it is wrong: timestamps are stored to the second, so two passes
   * inside one second share a stamp and the second one deletes nothing —
   * leaving a position the user has already closed on the page. The page
   * can refresh several times a second, so that is a real interval.
   *
   * One transaction, because a reader between the delete and the inserts
   * would be told the account holds nothing at all.
   */
  await db.transaction(async (transaction) => {
    await transaction.prepare('DELETE FROM venue_positions WHERE exchange_account_id = ?').run(account.id)
    await transaction.prepare('DELETE FROM venue_orders WHERE exchange_account_id = ?').run(account.id)

    for (const position of positions) {
      await writePosition(transaction, account, position, marketIds.get(position.marketExternalId) ?? 0, stamp)
      summary.positions++
    }

    for (const order of orders) {
      await writeOrder(transaction, account, order, marketIds.get(order.marketExternalId) ?? 0, stamp)
      summary.orders++
    }
  })
}

/**
 * Market ids for the tickers this account touches, fetching the metadata
 * we are missing.
 *
 * A venue ticker is not a question. `KXPRESPARTY-28-R` on a page is a
 * position the user cannot identify, so the public market endpoint is
 * asked about anything we have never stored, and the answer is upserted
 * into the same table ingestion writes — which also refreshes the last
 * price the portfolio marks against.
 *
 * A market we still cannot name is not an error. The position is real
 * and gets shown under its ticker; the row simply carries no market id.
 */
async function resolveMarkets(
  db: Database,
  venue: string,
  externalIds: string[],
  marketsFor: MarketLookup,
  stamp: string,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>()
  if (externalIds.length === 0)
    return ids

  const lookup = db.prepare<{ id: number, external_id: string }>(
    `SELECT id, external_id FROM prediction_markets WHERE venue = ? AND external_id IN (${externalIds.map(() => '?').join(', ')})`,
  )

  const markets = await marketsFor(venue, externalIds).catch((error) => {
    // Metadata is a nicety; holdings are not. A public endpoint being
    // down must not cost the user the sight of their own positions.
    log.warn(`[trading] could not refresh ${venue} market metadata: ${message(error)}`)
    return [] as VenueMarket[]
  })

  for (const market of markets) {
    await db.updateOrInsert('prediction_markets', { venue: market.venue, external_id: market.externalId }, {
      question: market.question,
      outcome_label: market.outcomeLabel ?? '',
      category: market.category,
      status: market.status,
      result: market.result,
      volume: market.volume,
      liquidity: market.liquidity,
      last_price: market.lastPrice,
      ends_at: market.endsAt,
      updated_at: stamp,
    })
  }

  for (const row of await lookup.all(venue, ...externalIds))
    ids.set(row.external_id, Number(row.id))

  return ids
}

async function writePosition(
  db: Database,
  account: AccountRow,
  position: VenuePosition,
  marketId: number,
  stamp: string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO venue_positions (
      exchange_account_id, prediction_market_id, venue, market_external_id, side,
      size, avg_price, synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id,
    marketId,
    account.venue,
    position.marketExternalId,
    position.side,
    position.size,
    position.avgPrice,
    stamp,
    stamp,
    stamp,
  )
}

async function writeOrder(
  db: Database,
  account: AccountRow,
  order: VenueOrder,
  marketId: number,
  stamp: string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO venue_orders (
      exchange_account_id, prediction_market_id, venue, external_order_id,
      market_external_id, side, limit_price, size, remaining_size, placed_at,
      synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id,
    marketId,
    account.venue,
    order.externalOrderId,
    order.marketExternalId,
    order.side,
    order.limitPrice,
    order.size,
    order.remainingSize,
    order.placedAt,
    stamp,
    stamp,
    stamp,
  )
}

/**
 * Record why an account did not sync, without disabling it.
 *
 * A timeout is not a bad key. The account stays active so the next pass
 * tries again, and the message gives the page something truthful to show
 * beside a balance that has stopped moving.
 */
async function noteFailure(db: Database, accountId: number, reason: string, stamp: string): Promise<void> {
  await db.prepare('UPDATE exchange_accounts SET last_error = ?, updated_at = ? WHERE id = ?')
    .run(reason.slice(0, 300), stamp, accountId)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
