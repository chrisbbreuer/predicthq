import type { Database } from '../../Support/db'
import type { Candidate } from './evidence'
import type { TradingClient } from './venue'
import { log } from '@stacksjs/logging'
import { resolveEntitlements } from '../billing/entitlements'
import { openCredentials } from './credentials'
import { jurisdictionObjection } from './eligibility'
import { haltState } from './halt'
import { KalshiTradingClient } from './kalshi-trading'
import { executePaper } from './paper'
import { PolymarketTradingClient } from './polymarket-trading'
import { accountOpenExposure, bookOrderFill, cumulativeRealizedLoss, openExposure, openPositionCount, realizedPnlSince } from './positions'
import { VenueError, isAuthFailure } from './venue'

/**
 * Turning an accepted decision into an order, or refusing to.
 *
 * Every refusal is recorded on the decision with its reason. A strategy
 * that quietly does nothing is indistinguishable from one that found no
 * edge, and the difference — out of money, over the position cap, venue
 * disconnected — is exactly what a user needs to see.
 *
 * The checks run in ascending cost: strategy state, then entitlement,
 * then our own database, then the venue. The venue is asked last because
 * it is the only one that costs a round trip.
 */

export interface Strategy {
  id: number
  user_id: number
  venue: string
  /** 'paper' | 'live'. Absent on strategies that predate the column. */
  mode: string | null
  bankroll: number
  max_stake: number
  min_edge: number
  min_confidence: number
  max_open_positions: number
  daily_loss_limit: number
  cumulative_loss_limit: number
  auto_execute: number
  status: string
}

export interface ExecutionOutcome {
  decisionId: number
  placed: boolean
  reason: string
}

/**
 * Position size from edge and confidence — a fractional Kelly stake.
 *
 * Full Kelly is the growth-optimal bet only when the probability is
 * exactly right, and ours is an estimate off a trade tape. A quarter
 * stake gives up a little growth for a lot of tolerance to being wrong
 * about fair value, which is the trade worth making here. Confidence
 * scales it again, so a thin-evidence edge sizes small rather than
 * being all-or-nothing.
 */
const KELLY_FRACTION = 0.25

/**
 * How old our view of a market's price may be when an order is sent.
 *
 * The trading loop runs every fifteen minutes and the price it decided
 * on came from whenever ingestion last ran. Sending an order against a
 * quote nobody has refreshed since is not trading on a stale price, it
 * is trading on no price at all — the venue is somewhere, and we do not
 * know where.
 */
const MAX_QUOTE_AGE_MINUTES = 10

/**
 * How far a market may move between the decision and the order.
 *
 * A limit price protects against paying too much; it does not protect
 * against the reasoning being obsolete. Three points of movement in a
 * binary market is news, and news is exactly the case where a fair value
 * derived from the preceding day's tape is no longer the right number.
 * Better to skip and let the next pass re-derive it from the tape that
 * now includes whatever moved it.
 */
const MAX_QUOTE_DRIFT = 0.03

export function stakeFor(candidate: Candidate, strategy: Strategy, availableBankroll: number): number {
  const price = candidate.marketPrice
  if (price <= 0 || price >= 1)
    return 0

  // Binary Kelly: edge over the odds paid. A contract bought at `price`
  // returns (1 − price) per unit staked.
  const kelly = (candidate.fairValue - price) / (1 - price)
  if (kelly <= 0)
    return 0

  const fraction = kelly * KELLY_FRACTION * candidate.confidence
  const stake = Math.min(
    availableBankroll * fraction,
    strategy.max_stake,
    availableBankroll,
  )

  return stake > 0 ? Math.floor(stake * 100) / 100 : 0
}

/**
 * Whether this strategy trades on paper.
 *
 * A strategy written before the column existed has no mode, and reading
 * that as paper would silently stop a live strategy from trading. So the
 * absent case is live, and only an explicit 'paper' simulates.
 */
export function isPaper(strategy: Pick<Strategy, 'mode'>): boolean {
  return strategy.mode === 'paper'
}

/** The venue client for an account, decrypting its credentials. */
export async function clientFor(sealedCredentials: string): Promise<TradingClient> {
  const credentials = await openCredentials(sealedCredentials)

  return credentials.venue === 'kalshi'
    ? new KalshiTradingClient(credentials)
    : new PolymarketTradingClient(credentials)
}

/**
 * Stop using an account the venue no longer accepts.
 *
 * Credentials rejected once will be rejected every subsequent call, so
 * the account is marked before the next pass reaches the network rather
 * than burning a round trip per order to relearn the same answer.
 */
export async function revokeAccount(db: Database, accountId: number, reason: string): Promise<void> {
  await db.prepare('UPDATE exchange_accounts SET status = \'revoked\', last_error = ?, updated_at = ? WHERE id = ?')
    .run(reason.slice(0, 300), new Date().toISOString(), accountId)
}

interface DecisionRow {
  id: number
  prediction_market_id: number
  venue: string
  side: string
  /** The venue price this decision was reasoned about. */
  market_price: number
  limit_price: number
  size: number
  notional: number
  confidence: number
  edge: number
}

interface AccountRow {
  id: number
  credentials: string
  status: string
  balance: number
  jurisdiction: string
}

export interface ExecutionOptions {
  /** Injectable for venue contract and concurrency tests. */
  clientFor?: (sealedCredentials: string) => Promise<TradingClient>
}

/**
 * Execute every approved decision for a strategy.
 *
 * Returns one outcome per decision, whether or not it placed. Failures
 * are isolated per decision: a venue rejecting one order must not stop
 * the rest, because the alternative is one bad market silently
 * disabling a whole strategy.
 */
export async function executeStrategy(
  db: Database,
  strategy: Strategy,
  decisionIds: number[],
  options: ExecutionOptions = {},
): Promise<ExecutionOutcome[]> {
  const outcomes: ExecutionOutcome[] = []

  if (decisionIds.length === 0)
    return outcomes

  const halted = await haltReason(db, strategy)
  if (halted) {
    // Halting is sticky: record it on the strategy so it survives the
    // process, and so the user sees why on the next page load.
    await db.prepare(`UPDATE trading_strategies SET status = 'halted', halted_reason = ?, updated_at = ? WHERE id = ?`)
      .run(halted, new Date().toISOString(), strategy.id)

    return await Promise.all(decisionIds.map(id => skip(db, id, halted)))
  }

  if (!strategy.auto_execute)
    return await Promise.all(decisionIds.map(id => skip(db, id, 'strategy is set to manual approval')))

  // Paper diverges here, after every limit the strategy declares has
  // already been checked and before anything that costs money. It needs
  // no entitlement, because the point of it is to be the thing a user
  // runs before they are willing to pay for the thing that trades — and
  // no venue account, because it never contacts one.
  if (isPaper(strategy))
    return await executePaper(db, strategy, decisionIds)

  // The deployment switch governs venue contact, not simulation. Keeping
  // paper strategies running while live placement is disabled is how a
  // read-only launch can still build a comparable track record.
  const global = await haltState(db)
  if (global.halted)
    return await Promise.all(decisionIds.map(id => skip(db, id, global.reason)))

  const accessObjection = liveAccessReason(strategy.user_id)
  if (accessObjection)
    return await Promise.all(decisionIds.map(id => skip(db, id, accessObjection)))

  const entitlements = await resolveEntitlements(db, strategy.user_id)
  if (!entitlements.canAutoExecute)
    return await Promise.all(decisionIds.map(id => skip(db, id, `plan ${entitlements.tier} does not include automated execution`)))

  const placeholders = decisionIds.map(() => '?').join(', ')
  const decisions = await db.prepare<DecisionRow>(`
    SELECT id, prediction_market_id, venue, side, market_price, limit_price, size, notional, confidence, edge
    FROM trade_decisions
    WHERE id IN (${placeholders})
    ORDER BY confidence DESC, edge DESC
  `).all(...decisionIds)

  // Cache one client per venue: constructing a Polymarket client derives
  // an account from the private key, which is not free per order.
  const clients = new Map<string, { client: TradingClient, account: AccountRow, available: number }>()
  const openClient = options.clientFor ?? clientFor

  for (const decision of decisions) {
    const openPositions = await openPositionCount(db, strategy.id)
    if (openPositions >= strategy.max_open_positions) {
      outcomes.push(await skip(db, decision.id, `at the ${strategy.max_open_positions}-position cap`))
      continue
    }

    const committed = await openExposure(db, strategy.id)
    if (committed + decision.notional > strategy.bankroll) {
      outcomes.push(await skip(db, decision.id, `would commit $${round(committed + decision.notional)} against a $${round(strategy.bankroll)} bankroll`))
      continue
    }

    let resolved = clients.get(decision.venue)
    if (!resolved) {
      const account = await db.prepare<AccountRow>(`
        SELECT id, credentials, status, balance, jurisdiction
        FROM exchange_accounts
        WHERE user_id = ? AND venue = ?
      `).get(strategy.user_id, decision.venue)

      if (!account) {
        outcomes.push(await skip(db, decision.id, `no ${decision.venue} account connected`))
        continue
      }

      if (account.status !== 'active') {
        outcomes.push(await skip(db, decision.id, `${decision.venue} account is ${account.status}`))
        continue
      }

      const jurisdictionError = jurisdictionObjection(decision.venue, account.jurisdiction)
      if (jurisdictionError) {
        outcomes.push(await skip(db, decision.id, jurisdictionError))
        continue
      }

      try {
        const client = await openClient(account.credentials)
        const balance = await client.fetchBalance()
        resolved = { client, account, available: balance.available }
        clients.set(decision.venue, resolved)

        await db.prepare(`
          UPDATE exchange_accounts
          SET balance = ?, last_synced_at = ?, last_error = '', updated_at = ?
          WHERE id = ?
        `).run(balance.available, new Date().toISOString(), new Date().toISOString(), account.id)
      }
      catch (error) {
        outcomes.push(await skip(db, decision.id, error instanceof Error ? error.message : String(error)))
        continue
      }
    }

    if (decision.notional > resolved.available) {
      outcomes.push(await skip(db, decision.id, `venue has $${round(resolved.available)} available, below this order's $${round(decision.notional)} notional`))
      continue
    }

    const testCap = positiveNumber(process.env.TRADING_BANKROLL_CAP_USD)
    if (testCap > 0) {
      const accountCommitted = await accountOpenExposure(db, resolved.account.id)
      if (accountCommitted + decision.notional > testCap) {
        outcomes.push(await skip(db, decision.id, `would commit $${round(accountCommitted + decision.notional)} against the deployment's $${round(testCap)} live bankroll cap`))
        continue
      }
    }

    const outcome = await placeOne(db, strategy, decision, resolved.client, resolved.account)
    outcomes.push(outcome)

    // A resting order reserves its full limit notional at the venue. Keep
    // the in-pass balance conservative so a batch cannot spend the same
    // available dollar twice before the next venue balance refresh.
    if (outcome.placed)
      resolved.available = Math.max(0, resolved.available - decision.notional)
  }

  return outcomes
}

function positiveNumber(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** Keep a private $20 validation from silently becoming a public rollout. */
export function liveAccessReason(userId: number, env: Record<string, string | undefined> = process.env): string {
  if (env.APP_ENV !== 'production')
    return ''
  if (['true', '1'].includes((env.PUBLIC_LIVE_TRADING_ENABLED ?? '').toLowerCase()))
    return ''

  const allowlist = (env.LIVE_TRADING_USER_ALLOWLIST ?? '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0)

  return allowlist.includes(userId)
    ? ''
    : 'live trading is limited to the controlled launch allowlist; paper trading remains available'
}

/**
 * Place one order.
 *
 * The row is written BEFORE the network call so a process that dies
 * mid-flight leaves evidence of an order that may exist at the venue.
 * Recovering from a missing row means reconciling against the venue by
 * hand; recovering from a 'pending' row is a status lookup.
 */
async function placeOne(
  db: Database,
  strategy: Strategy,
  decision: DecisionRow,
  client: TradingClient,
  account: AccountRow,
): Promise<ExecutionOutcome> {
  const now = new Date().toISOString()
  const clientOrderId = clientOrderIdFor(strategy.id, decision.id)

  const market = await db.prepare<{
    external_id: string
    status: string
    last_price: number
    updated_at: string
  }>('SELECT external_id, status, last_price, updated_at FROM prediction_markets WHERE id = ?')
    .get(decision.prediction_market_id)

  if (!market)
    return await skip(db, decision.id, 'market no longer in our database')

  const stale = quoteObjection(decision, market, now)
  if (stale)
    return await skip(db, decision.id, stale)

  const claim = await db.upsert('exchange_orders', [{
    trade_decision_id: decision.id,
    exchange_account_id: account.id,
    venue: decision.venue,
    client_order_id: clientOrderId,
    external_order_id: '',
    market_external_id: market.external_id,
    side: decision.side,
    limit_price: decision.limit_price,
    size: decision.size,
    filled_size: 0,
    avg_fill_price: 0,
    accrued_size: 0,
    accrued_cost: 0,
    status: 'pending',
    error: '',
    placed_at: now,
    created_at: now,
    updated_at: now,
  }], ['trade_decision_id'])

  const claimed = await db.prepare<{ id: number, status: string }>(
    'SELECT id, status FROM exchange_orders WHERE trade_decision_id = ?',
  ).get(decision.id)

  if (!claimed)
    return await skip(db, decision.id, 'could not create an idempotent order claim')

  // Another request already owns this decision. It either placed the
  // order or left a pending row that reconciliation will replay under the
  // same deterministic venue key. Never contact the venue from both.
  if (claim.changes === 0) {
    return {
      decisionId: decision.id,
      placed: ['pending', 'open', 'partial', 'filled'].includes(claimed.status),
      reason: `order already ${claimed.status}`,
    }
  }

  const orderId = Number(claimed.id)

  // Re-check the deployment cap after the pending row exists. The row is
  // the reservation, so concurrent decisions see one another before either
  // contacts the venue. Two racing orders may conservatively reject both;
  // they can never both pass by reading the same pre-reservation total.
  const testCap = positiveNumber(process.env.TRADING_BANKROLL_CAP_USD)
  if (testCap > 0) {
    const reserved = await accountOpenExposure(db, account.id)
    if (reserved > testCap) {
      const reason = `would reserve $${round(reserved)} against the deployment's $${round(testCap)} live bankroll cap`
      await db.prepare(`UPDATE exchange_orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .run(reason, new Date().toISOString(), orderId)
      return await skip(db, decision.id, reason)
    }
  }

  try {
    const result = await client.placeOrder({
      marketExternalId: market.external_id,
      side: decision.side,
      limitPrice: decision.limit_price,
      size: decision.size,
      clientOrderId,
    })

    await db.prepare(`
      UPDATE exchange_orders
      SET external_order_id = ?, status = ?, filled_size = ?, avg_fill_price = ?, updated_at = ?
      WHERE id = ?
    `).run(result.externalOrderId, result.status, result.filledSize, result.avgFillPrice, new Date().toISOString(), orderId)

    // An order can cross the moment it is submitted, and a fill that
    // crosses here is terminal — reconciliation only looks at orders
    // that can still change, so it would never see this one. Booking it
    // now is what keeps an immediate fill from being a position nobody
    // knows we hold.
    await bookOrderFill(db, {
      orderId,
      tradingStrategyId: strategy.id,
      exchangeAccountId: account.id,
      predictionMarketId: decision.prediction_market_id,
      venue: decision.venue,
      marketExternalId: market.external_id,
      side: decision.side,
      accruedSize: 0,
      accruedCost: 0,
    }, result.filledSize, result.avgFillPrice)

    await db.prepare(`UPDATE trade_decisions SET status = 'executed', status_reason = '', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), decision.id)

    return { decisionId: decision.id, placed: true, reason: result.status }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    await db.prepare(`UPDATE exchange_orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(message.slice(0, 500), new Date().toISOString(), orderId)

    await db.prepare(`UPDATE trade_decisions SET status = 'failed', status_reason = ?, updated_at = ? WHERE id = ?`)
      .run(message.slice(0, 300), new Date().toISOString(), decision.id)

    if (error instanceof VenueError && isAuthFailure(error.status)) {
      await revokeAccount(db, account.id, message)
      log.warn(`[trading] ${decision.venue} rejected our credentials; account ${account.id} marked revoked`)
    }

    return { decisionId: decision.id, placed: false, reason: message }
  }
}

/**
 * Why this decision must not reach the venue now, or '' if it may.
 *
 * A decision carries the price it was reasoned about. Between then and
 * here the market has kept trading and the ingestion loop has kept
 * running, and this is the last point at which the two can be compared
 * before real money depends on the answer.
 */
export function quoteObjection(
  decision: Pick<DecisionRow, 'market_price' | 'limit_price'>,
  market: { status: string, last_price: number, updated_at: string },
  now: string,
): string {
  if (market.status !== 'open' && market.status !== 'active')
    return `market is ${market.status}`

  const age = Date.parse(now) - Date.parse(market.updated_at)
  if (!Number.isFinite(age) || age > MAX_QUOTE_AGE_MINUTES * 60_000)
    return `no price for this market in the last ${MAX_QUOTE_AGE_MINUTES} minutes`

  const drift = market.last_price - decision.market_price
  if (Math.abs(drift) > MAX_QUOTE_DRIFT) {
    return `market moved ${drift > 0 ? 'up' : 'down'} ${(Math.abs(drift) * 100).toFixed(1)} points since this was decided`
  }

  // At or through our limit there is no edge left to take. The order
  // would rest unfilled until the expiry pass cancelled it, holding
  // bankroll against a trade we no longer want.
  if (market.last_price >= decision.limit_price)
    return `market is quoted at ${(market.last_price * 100).toFixed(1)} against our ${(decision.limit_price * 100).toFixed(1)} limit`

  return ''
}

/**
 * Why this strategy must not trade right now, or '' if it may.
 *
 * The daily limit is on realized loss — positions closed today, at what
 * they actually returned against what they cost. Two things it is
 * deliberately not:
 *
 *   Not capital deployed. Summing what filled orders cost calls a
 *   strategy that put $1,000 to work and is up on it "down $1,000",
 *   which halts a winning strategy for the crime of trading.
 *
 *   Not marked to market. An open position moving against us has not
 *   cost anything yet, and a limit that trips on an unrealized swing
 *   closes the book on exactly the days it should stay open.
 *
 * How much a strategy may have at risk at once is a different question,
 * and the bankroll check answers it.
 */
async function haltReason(db: Database, strategy: Strategy): Promise<string> {
  if (strategy.status === 'halted')
    return 'strategy is halted'
  if (strategy.status !== 'active')
    return `strategy is ${strategy.status}`

  if (strategy.daily_loss_limit > 0) {
    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    const realized = await realizedPnlSince(db, strategy.id, startOfDay)

    // Only a loss counts. A profitable day never halts a strategy, and
    // gains do not net against a limit that exists to stop a bad run.
    if (realized < 0 && Math.abs(realized) >= strategy.daily_loss_limit)
      return `daily loss limit reached (down $${round(Math.abs(realized))} of $${round(strategy.daily_loss_limit)} today)`
  }

  if (strategy.cumulative_loss_limit > 0) {
    const lost = await cumulativeRealizedLoss(db, strategy.id)
    if (lost >= strategy.cumulative_loss_limit)
      return `cumulative loss limit reached (lost $${round(lost)} of $${round(strategy.cumulative_loss_limit)})`
  }

  return ''
}

async function skip(db: Database, decisionId: number, reason: string): Promise<ExecutionOutcome> {
  await db.prepare(`UPDATE trade_decisions SET status = 'skipped', status_reason = ?, updated_at = ? WHERE id = ?`)
    .run(reason.slice(0, 300), new Date().toISOString(), decisionId)

  return { decisionId, placed: false, reason }
}

function round(value: number): string {
  return value.toFixed(2)
}

/** Stable at every retry and short enough for both venues. */
export function clientOrderIdFor(strategyId: number, decisionId: number): string {
  return `predicthq-${strategyId}-${decisionId}`
}
