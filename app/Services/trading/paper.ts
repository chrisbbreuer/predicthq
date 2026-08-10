import type { Database } from '../../Support/db'
import type { ExecutionOutcome, Strategy } from './execute'
import { bookOrderFill } from './positions'

/**
 * Trading a strategy without money.
 *
 * A strategy went from "saved" to "placing real orders at an exchange"
 * with nothing in between, so nobody — the user or us — could say whether
 * it had ever been right. Paper mode closes that gap by running the same
 * path: the same evidence, the same judgement, the same limits, the same
 * risk checks, and fills booked into the same positions table that
 * settles against the same results. What it does not do is contact a
 * venue or need an account.
 *
 * Because the record lands in the same place, the performance figures
 * for a paper strategy and a live one are computed by identical code. A
 * separate simulator with its own bookkeeping would be a second
 * implementation of the thing being measured, and the number it produced
 * would mean something subtly different from the live one — which is
 * exactly the number a user is trying to compare against.
 */

/**
 * What a simulated fill gives up to the spread.
 *
 * We record a market's last traded price, not its ask, so a buy filled
 * at the recorded price is filled at roughly half a spread better than a
 * real one would have been. Assuming a cent against ourselves keeps
 * paper results from reading systematically better than live results,
 * which is the one way a paper mode can actively mislead.
 */
const ASSUMED_SLIPPAGE = 0.01

interface PaperDecision {
  id: number
  prediction_market_id: number
  venue: string
  side: string
  limit_price: number
  size: number
}

/**
 * Fill every approved decision against the tape.
 *
 * A limit order fills only if the market is at or below the limit, and
 * the price paid is the worse of the two: the market when it is below
 * our limit, the limit when slippage carries it past. A decision that
 * cannot fill is recorded as unfilled rather than quietly credited,
 * because a paper record that fills everything is a paper record that
 * proves nothing.
 */
export async function executePaper(
  db: Database,
  strategy: Strategy,
  decisionIds: number[],
): Promise<ExecutionOutcome[]> {
  const outcomes: ExecutionOutcome[] = []
  if (decisionIds.length === 0)
    return outcomes

  const placeholders = decisionIds.map(() => '?').join(', ')
  const decisions = await db.prepare<PaperDecision>(`
    SELECT id, prediction_market_id, venue, side, limit_price, size
    FROM trade_decisions
    WHERE id IN (${placeholders})
    ORDER BY id
  `).all(...decisionIds)

  for (const decision of decisions) {
    const market = await db.prepare<{ external_id: string, last_price: number }>(
      'SELECT external_id, last_price FROM prediction_markets WHERE id = ?',
    ).get(decision.prediction_market_id)

    if (!market) {
      outcomes.push(await record(db, strategy.id, decision, 'cancelled', 0, 0, 'market no longer in our database'))
      continue
    }

    const fillPrice = Math.min(decision.limit_price, Number(market.last_price) + ASSUMED_SLIPPAGE)

    if (Number(market.last_price) > decision.limit_price) {
      outcomes.push(await record(db, strategy.id, decision, 'cancelled', 0, 0, 'the market never traded down to the limit'))
      continue
    }

    outcomes.push(await record(db, strategy.id, decision, 'filled', decision.size, fillPrice, ''))
  }

  return outcomes
}

/**
 * Write the simulated order and, when it filled, the position it made.
 *
 * The venue is recorded as `paper:<venue>` so a simulated order can never
 * be mistaken for a real one in a query that forgot to filter, and the
 * account is left null because there is no account — both make the row
 * inert to the reconciliation pass, which has nothing to ask a venue
 * about.
 */
async function record(
  db: Database,
  strategyId: number,
  decision: PaperDecision,
  status: string,
  filledSize: number,
  fillPrice: number,
  note: string,
): Promise<ExecutionOutcome> {
  const now = new Date().toISOString()

  const market = await db.prepare<{ external_id: string }>('SELECT external_id FROM prediction_markets WHERE id = ?')
    .get(decision.prediction_market_id)

  const claim = await db.upsert('exchange_orders', [{
    trade_decision_id: decision.id,
    exchange_account_id: null,
    venue: `paper:${decision.venue}`,
    client_order_id: `paper-${strategyId}-${decision.id}`,
    external_order_id: '',
    market_external_id: market?.external_id ?? '',
    side: decision.side,
    limit_price: decision.limit_price,
    size: decision.size,
    filled_size: filledSize,
    avg_fill_price: fillPrice,
    accrued_size: 0,
    accrued_cost: 0,
    status,
    error: note,
    placed_at: now,
    created_at: now,
    updated_at: now,
  }], ['trade_decision_id'])

  const order = await db.prepare<{ id: number, status: string, avg_fill_price: number, error: string }>(
    'SELECT id, status, avg_fill_price, error FROM exchange_orders WHERE trade_decision_id = ?',
  ).get(decision.id)

  if (!order)
    return { decisionId: decision.id, placed: false, reason: 'could not create a paper order claim' }

  if (claim.changes === 0) {
    return {
      decisionId: decision.id,
      placed: order.status === 'filled',
      reason: order.status === 'filled'
        ? `already filled on paper at ${(Number(order.avg_fill_price) * 100).toFixed(1)}`
        : order.error || `paper order already ${order.status}`,
    }
  }

  if (filledSize > 0) {
    await bookOrderFill(db, {
      orderId: Number(order.id),
      tradingStrategyId: strategyId,
      exchangeAccountId: null,
      predictionMarketId: decision.prediction_market_id,
      venue: `paper:${decision.venue}`,
      marketExternalId: market?.external_id ?? '',
      side: decision.side,
      accruedSize: 0,
      accruedCost: 0,
    }, filledSize, fillPrice)
  }

  const placed = filledSize > 0

  await db.prepare('UPDATE trade_decisions SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
    .run(placed ? 'executed' : 'skipped', note.slice(0, 300), now, decision.id)

  return {
    decisionId: decision.id,
    placed,
    reason: placed ? `filled on paper at ${(fillPrice * 100).toFixed(1)}` : note,
  }
}
