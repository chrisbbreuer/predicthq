import type { Database } from '../../Support/db'
import type { PlaceOrderResult, TradingClient } from './venue'
import { log } from '@stacksjs/logging'
import { clientFor, revokeAccount } from './execute'
import { bookOrderFill } from './positions'
import { isAuthFailure, VenueError } from './venue'

/**
 * Reconciling our record of an order with the venue's.
 *
 * Placement writes a row and then makes one network call, and whatever
 * that call returned is true for exactly one instant. A resting limit
 * order is not filled because the venue accepted it, a partial fill
 * grows, and a process that died between the INSERT and the response
 * left a row claiming an order we may or may not have placed. Nothing
 * downstream — position caps, bankroll, the daily loss limit, a user
 * asking what they own — is correct until something asks the venue.
 *
 * Three passes, in this order, because each depends on the last:
 *
 *   1. **Recover** rows that never learned their venue id.
 *   2. **Poll** every non-terminal order for its current fills.
 *   3. **Expire** anything still resting past its time to live.
 *
 * Every pass is per-order isolated: one venue rejecting one lookup must
 * not stop the rest, or a single bad row freezes reconciliation for
 * every user on that venue.
 */

/**
 * How long an unfilled limit order may rest before we take it back.
 *
 * The limit price came from a fair value computed at decision time. An
 * order that has not filled in this long is either priced away from the
 * market or waiting on a market that has moved, and in both cases the
 * capital it pins is worth more than the fill. Cancelling also releases
 * it back to the bankroll, which is the only reason a strategy can keep
 * trading past its first few markets.
 */
const RESTING_TTL_MINUTES = 45

/** Statuses that can still change, and so still need to be asked about. */
const NON_TERMINAL = ['pending', 'open', 'partial'] as const

export interface SyncOptions {
  now?: Date
  /**
   * How to obtain a client for an account's sealed credentials.
   *
   * Injectable so the reconciliation logic can be exercised against a
   * venue that behaves the way a test needs it to. Every branch here is
   * about what a venue said, and a test that cannot make a venue say
   * something is a test of nothing.
   */
  clientFor?: (sealedCredentials: string) => Promise<TradingClient>
}

export interface SyncSummary {
  /** Rows examined. */
  examined: number
  /** Orders whose venue id we learned by replaying the placement. */
  recovered: number
  /** Orders whose status or fill count changed. */
  advanced: number
  /** Resting orders cancelled for age. */
  expired: number
  /** Orders we could not reach the venue for. */
  unreachable: number
}

interface OrderRow {
  id: number
  trade_decision_id: number
  exchange_account_id: number
  venue: string
  client_order_id: string
  external_order_id: string
  market_external_id: string
  side: string
  limit_price: number
  size: number
  filled_size: number
  avg_fill_price: number
  accrued_size: number | null
  accrued_cost: number | null
  status: string
  placed_at: string
  trading_strategy_id: number
  prediction_market_id: number
  account_credentials: string
  account_status: string
}

/**
 * Reconcile every open order across every account.
 *
 * Clients are cached per account because constructing one derives an
 * address from a private key, which is not free, and an account
 * typically has several orders in flight.
 */
export async function syncOrders(db: Database, options: SyncOptions = {}): Promise<SyncSummary> {
  const now = options.now ?? new Date()
  const openClient = options.clientFor ?? clientFor
  const summary: SyncSummary = { examined: 0, recovered: 0, advanced: 0, expired: 0, unreachable: 0 }

  const placeholders = NON_TERMINAL.map(() => '?').join(', ')
  const orders = await db.prepare<OrderRow>(`
    SELECT
      o.id, o.trade_decision_id, o.exchange_account_id, o.venue, o.client_order_id,
      o.external_order_id, o.market_external_id, o.side, o.limit_price, o.size,
      o.filled_size, o.avg_fill_price, o.accrued_size, o.accrued_cost, o.status, o.placed_at,
      d.trading_strategy_id, d.prediction_market_id,
      a.credentials AS account_credentials, a.status AS account_status
    FROM exchange_orders o
    JOIN exchange_accounts a ON a.id = o.exchange_account_id
    JOIN trade_decisions d ON d.id = o.trade_decision_id
    WHERE o.status IN (${placeholders})
    ORDER BY o.exchange_account_id, o.id
  `).all(...NON_TERMINAL)

  const clients = new Map<number, TradingClient>()

  for (const order of orders) {
    summary.examined++

    // A revoked account cannot be asked anything. Leaving the row alone
    // is the honest outcome: we genuinely do not know what became of it,
    // and inventing a status would hide a real position.
    if (order.account_status !== 'active') {
      summary.unreachable++
      continue
    }

    let client = clients.get(order.exchange_account_id)
    if (!client) {
      try {
        client = await openClient(order.account_credentials)
        clients.set(order.exchange_account_id, client)
      }
      catch (error) {
        summary.unreachable++
        log.warn(`[trading] could not open a client for account ${order.exchange_account_id}: ${message(error)}`)
        continue
      }
    }

    try {
      await syncOne(db, client, order, now, summary)
    }
    catch (error) {
      summary.unreachable++

      if (error instanceof VenueError && isAuthFailure(error.status)) {
        await revokeAccount(db, order.exchange_account_id, message(error))
        clients.delete(order.exchange_account_id)
        log.warn(`[trading] ${order.venue} rejected our credentials during sync; account ${order.exchange_account_id} marked revoked`)
        continue
      }

      log.warn(`[trading] could not reconcile order ${order.id}: ${message(error)}`)
    }
  }

  return summary
}

/** Reconcile one order, including the expiry that may follow. */
async function syncOne(
  db: Database,
  client: TradingClient,
  order: OrderRow,
  now: Date,
  summary: SyncSummary,
): Promise<void> {
  if (!order.external_order_id && client.supportsIdempotentReplay === false) {
    await markUncertain(db, order, 'venue response was lost; refusing to replay a non-idempotent order')
    summary.advanced++
    return
  }

  let result = order.external_order_id
    ? await client.fetchOrder(order.external_order_id)
    : await recover(client, order, summary)

  // A venue that has never heard of the id is a real answer, not a
  // failure: nothing was placed, so nothing is owed and nothing rests.
  if (!result) {
    await writeStatus(db, order, 'cancelled', 0, 0, 'the venue has no record of this order')
    summary.advanced++
    return
  }

  if (isResting(result.status) && restedTooLong(order.placed_at, now)) {
    const cancelled = await client.cancelOrder(result.externalOrderId)

    if (cancelled) {
      // Re-read after cancelling: a fill can land between the decision to
      // cancel and the venue acting on it, and a fill we drop here is a
      // position nobody knows we hold.
      result = await client.fetchOrder(result.externalOrderId) ?? {
        ...result,
        status: result.filledSize > 0 ? 'partial' : 'cancelled',
      }
      summary.expired++
    }
  }

  const changed = result.status !== order.status
    || result.filledSize !== order.filled_size
    || result.externalOrderId !== order.external_order_id

  if (!changed)
    return

  await writeStatus(db, order, result.status, result.filledSize, result.avgFillPrice, '', result.externalOrderId)
  summary.advanced++
}

async function markUncertain(db: Database, order: OrderRow, note: string): Promise<void> {
  const now = new Date().toISOString()
  await db.transaction(async (transaction) => {
    await transaction.prepare(`
      UPDATE exchange_orders SET status = 'uncertain', error = ?, updated_at = ? WHERE id = ?
    `).run(note, now, order.id)
    await transaction.prepare(`
      UPDATE trade_decisions SET status = 'review', status_reason = ?, updated_at = ? WHERE id = ?
    `).run(note, now, order.trade_decision_id)
  })
}

/**
 * Learn the venue id of an order that never recorded one.
 *
 * The row was written before the network call, so a process that died in
 * between left an order that may or may not exist at the venue. Replaying
 * the placement with the same client order id is what resolves it: that
 * id is the venue's idempotency key, so a duplicate collapses onto the
 * original rather than doubling the position, and the response carries
 * the id we are missing.
 *
 * Replaying is bounded on both sides. The limit price is the one the
 * decision authorized, so a replay cannot pay more than the original
 * would have, and an order that rests is cancelled by the expiry pass in
 * this same run once it is past its time to live.
 */
async function recover(
  client: TradingClient,
  order: OrderRow,
  summary: SyncSummary,
): Promise<PlaceOrderResult | null> {
  const result = await client.placeOrder({
    marketExternalId: order.market_external_id,
    side: order.side,
    limitPrice: order.limit_price,
    size: order.size,
    clientOrderId: order.client_order_id,
  })

  summary.recovered++
  return result
}

/** Statuses that mean the order is still live on the book. */
function isResting(status: string): boolean {
  return status === 'open' || status === 'partial'
}

function restedTooLong(placedAt: string, now: Date): boolean {
  const placed = Date.parse(placedAt)
  if (!Number.isFinite(placed))
    return false

  return now.getTime() - placed >= RESTING_TTL_MINUTES * 60_000
}

/**
 * Persist a reconciled status, book any new fill, and carry both through
 * to the decision.
 *
 * The three writes belong in one transaction. A fill booked into a
 * position without the matching accrual mark on the order is booked
 * again on the next pass, and an accrual mark without the position is a
 * fill nobody owns — either way the strategy's exposure stops matching
 * what the venue says it holds.
 *
 * A decision is marked 'executed' the moment its order is accepted,
 * which is the right thing to record at the time and the wrong thing to
 * leave behind when the order is later cancelled unfilled. Rewriting it
 * to 'expired' keeps the feed honest and lets the strategy consider the
 * market again, which a permanently-executed decision would prevent.
 */
async function writeStatus(
  db: Database,
  order: OrderRow,
  status: string,
  filledSize: number,
  avgFillPrice: number,
  note: string,
  externalOrderId?: string,
): Promise<void> {
  const now = new Date().toISOString()

  await db.transaction(async (transaction) => {
    await transaction.prepare(`
      UPDATE exchange_orders
      SET status = ?, filled_size = ?, avg_fill_price = ?, external_order_id = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      filledSize,
      avgFillPrice,
      externalOrderId ?? order.external_order_id,
      note,
      now,
      order.id,
    )

    await bookOrderFill(transaction, {
      orderId: order.id,
      tradingStrategyId: order.trading_strategy_id,
      exchangeAccountId: order.exchange_account_id,
      predictionMarketId: order.prediction_market_id,
      venue: order.venue,
      marketExternalId: order.market_external_id,
      side: order.side,
      accruedSize: Number(order.accrued_size ?? 0),
      accruedCost: Number(order.accrued_cost ?? 0),
    }, filledSize, avgFillPrice)

    if (status === 'cancelled' && filledSize === 0) {
      await transaction.prepare(`
        UPDATE trade_decisions
        SET status = 'expired', status_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'executed'
      `).run(note || 'the order was cancelled before it filled', now, order.trade_decision_id)
    }
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
