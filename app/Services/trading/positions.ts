import type { Database } from '../../Support/db'

/**
 * The book: what a strategy owns, and what it earned.
 *
 * Orders and positions are different things on different clocks. An
 * order lives for minutes and then stops changing; the position it
 * creates lives until the market resolves, weeks later. Reading risk off
 * the orders table conflates the two — a filled order stays filled
 * forever, so every risk check that counted filled orders as live
 * exposure ratcheted one way and never came back down.
 *
 * Positions accrue from reconciled fills, never from placement, so the
 * cost basis is what the venue actually charged. They close against the
 * market's own result, and the difference is the realized profit or loss
 * that the daily loss limit and every performance number read from.
 */

export interface Fill {
  tradingStrategyId: number
  /** Null for a paper fill, which belongs to no venue account. */
  exchangeAccountId: number | null
  predictionMarketId: number
  venue: string
  marketExternalId: string
  side: string
  /** Contracts in this increment — not the order's running total. */
  size: number
  /** USD paid for this increment. */
  cost: number
}

export interface SettlementSummary {
  settled: number
  realized: number
}

/**
 * Everything needed to book an order's fills, gathered in one place so
 * both the placement path and the reconciliation path book them the same
 * way. They are the only two moments a fill can be learned: an order can
 * cross the moment it is submitted, or at any point while it rests.
 */
export interface OrderBooking {
  orderId: number
  tradingStrategyId: number
  exchangeAccountId: number | null
  predictionMarketId: number
  venue: string
  marketExternalId: string
  side: string
  /** What this order has already had booked. */
  accruedSize: number
  accruedCost: number
}

/**
 * Fold whatever is newly filled on an order into its strategy's position.
 *
 * Venues report a fill as a running total and an average price, never as
 * the increment since we last looked, so the increment is the difference
 * against what this order has already had booked. Recording that mark on
 * the order is what makes a partial fill that grows across several
 * passes count once rather than once per pass.
 *
 * Returns the contracts booked, which is zero whenever the venue is
 * telling us something we have already recorded.
 */
export async function bookOrderFill(
  db: Database,
  booking: OrderBooking,
  filledSize: number,
  avgFillPrice: number,
): Promise<number> {
  const deltaSize = filledSize - booking.accruedSize
  if (deltaSize <= 0)
    return 0

  const filledCost = filledSize * avgFillPrice

  await accrueFill(db, {
    tradingStrategyId: booking.tradingStrategyId,
    exchangeAccountId: booking.exchangeAccountId,
    predictionMarketId: booking.predictionMarketId,
    venue: booking.venue,
    marketExternalId: booking.marketExternalId,
    side: booking.side,
    size: deltaSize,
    cost: filledCost - booking.accruedCost,
  })

  await db.prepare('UPDATE exchange_orders SET accrued_size = ?, accrued_cost = ?, updated_at = ? WHERE id = ?')
    .run(filledSize, filledCost, new Date().toISOString(), booking.orderId)

  return deltaSize
}

/**
 * Fold one fill increment into the strategy's open position.
 *
 * Adding to an existing row rather than writing one per fill is what
 * makes the cost basis a weighted average across every fill that built
 * the position, which is the only basis against which a settlement
 * payout means anything.
 *
 * A settled row is never reopened. Buying back into a market that
 * already resolved for us is a new position with its own basis, and
 * merging it into the closed one would rewrite a result already
 * reported.
 */
export async function accrueFill(db: Database, fill: Fill): Promise<number> {
  if (fill.size <= 0)
    return 0

  const now = new Date().toISOString()

  const existing = await db.prepare<{ id: number, size: number, cost_basis: number }>(`
    SELECT id, size, cost_basis
    FROM exchange_positions
    WHERE trading_strategy_id = ? AND market_external_id = ? AND side = ? AND status = 'open'
    ORDER BY id
    LIMIT 1
  `).get(fill.tradingStrategyId, fill.marketExternalId, fill.side)

  if (existing) {
    const size = Number(existing.size) + fill.size
    const costBasis = Number(existing.cost_basis) + fill.cost

    await db.prepare(`
      UPDATE exchange_positions
      SET size = ?, cost_basis = ?, avg_price = ?, updated_at = ?
      WHERE id = ?
    `).run(size, costBasis, size > 0 ? costBasis / size : 0, now, existing.id)

    return existing.id
  }

  const insert = await db.prepare(`
    INSERT INTO exchange_positions (
      trading_strategy_id, exchange_account_id, prediction_market_id, venue,
      market_external_id, side, size, cost_basis, avg_price, realized_pnl,
      status, settlement_price, opened_at, settled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', 0, ?, '', ?, ?)
  `).run(
    fill.tradingStrategyId,
    fill.exchangeAccountId,
    fill.predictionMarketId,
    fill.venue,
    fill.marketExternalId,
    fill.side,
    fill.size,
    fill.cost,
    fill.size > 0 ? fill.cost / fill.size : 0,
    now,
    now,
    now,
  )

  return Number(insert.lastInsertRowid)
}

/**
 * Close every open position whose market has resolved.
 *
 * A prediction-market contract pays a dollar if its side was right and
 * nothing if it was not, so the payout is the size or zero and the
 * realized result is that minus what we paid. Both the settlement price
 * and the profit are written down rather than derived on read: a venue
 * that corrects a result months later must not silently restate a number
 * a user has already been shown.
 *
 * Only markets the ingestion loop marked settled with a non-empty result
 * are considered, which is the same condition the trade-tape grading
 * uses — two places disagreeing about what "resolved" means is how the
 * smart-money score and the P&L drift apart.
 */
export async function settlePositions(db: Database): Promise<SettlementSummary> {
  const summary: SettlementSummary = { settled: 0, realized: 0 }
  const now = new Date().toISOString()

  const due = await db.prepare<{
    id: number
    side: string
    size: number
    cost_basis: number
    result: string
  }>(`
    SELECT p.id, p.side, p.size, p.cost_basis, m.result
    FROM exchange_positions p
    JOIN prediction_markets m ON m.id = p.prediction_market_id
    WHERE p.status = 'open'
      AND m.status = 'settled'
      AND m.result != ''
    ORDER BY p.id
  `).all()

  for (const position of due) {
    const won = position.side.toLowerCase() === position.result.toLowerCase()
    const settlementPrice = won ? 1 : 0
    const realized = round(settlementPrice * Number(position.size) - Number(position.cost_basis))

    await db.prepare(`
      UPDATE exchange_positions
      SET status = 'settled', settlement_price = ?, realized_pnl = ?, settled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(settlementPrice, realized, now, now, position.id)

    summary.settled++
    summary.realized = round(summary.realized + realized)
  }

  return summary
}

/** Open positions a strategy holds, for its position cap. */
export async function openPositionCount(db: Database, strategyId: number): Promise<number> {
  const row = await db.prepare<{ n: number }>(
    'SELECT COUNT(*) AS n FROM exchange_positions WHERE trading_strategy_id = ? AND status = \'open\' AND size > 0',
  ).get(strategyId)

  return Number(row?.n ?? 0)
}

/**
 * USD a strategy currently has at risk.
 *
 * Two components, because capital is committed at two different moments:
 * what open positions cost, and what orders still working could still
 * cost. Counting only one of them lets a strategy commit its bankroll
 * twice — once in resting orders and again in the fills they become.
 */
export async function openExposure(db: Database, strategyId: number): Promise<number> {
  const positions = await db.prepare<{ total: number }>(
    'SELECT COALESCE(SUM(cost_basis), 0) AS total FROM exchange_positions WHERE trading_strategy_id = ? AND status = \'open\'',
  ).get(strategyId)

  // Only the unfilled remainder of a working order: the filled part is
  // already counted above as a position's cost basis.
  const working = await db.prepare<{ total: number }>(`
    SELECT COALESCE(SUM(o.limit_price * (o.size - COALESCE(o.accrued_size, 0))), 0) AS total
    FROM exchange_orders o
    JOIN trade_decisions d ON d.id = o.trade_decision_id
    WHERE d.trading_strategy_id = ? AND o.status IN ('pending', 'open', 'partial')
  `).get(strategyId)

  return round(Number(positions?.total ?? 0) + Number(working?.total ?? 0))
}

/** USD currently committed through one real-money venue account. */
export async function accountOpenExposure(db: Database, accountId: number): Promise<number> {
  const positions = await db.prepare<{ total: number }>(
    'SELECT COALESCE(SUM(cost_basis), 0) AS total FROM exchange_positions WHERE exchange_account_id = ? AND status = \'open\'',
  ).get(accountId)

  const working = await db.prepare<{ total: number }>(`
    SELECT COALESCE(SUM(limit_price * (size - COALESCE(accrued_size, 0))), 0) AS total
    FROM exchange_orders
    WHERE exchange_account_id = ? AND status IN ('pending', 'open', 'partial')
  `).get(accountId)

  return round(Number(positions?.total ?? 0) + Number(working?.total ?? 0))
}

/** Realized profit or loss booked on or after `since`, in USD. */
export async function realizedPnlSince(db: Database, strategyId: number, since: string): Promise<number> {
  const row = await db.prepare<{ total: number }>(`
    SELECT COALESCE(SUM(realized_pnl), 0) AS total
    FROM exchange_positions
    WHERE trading_strategy_id = ? AND status = 'settled' AND settled_at >= ?
  `).get(strategyId, since)

  return round(Number(row?.total ?? 0))
}

/** Gross realized losses over the lifetime of a strategy. Wins never refill this budget. */
export async function cumulativeRealizedLoss(db: Database, strategyId: number): Promise<number> {
  const row = await db.prepare<{ total: number }>(`
    SELECT COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN -realized_pnl ELSE 0 END), 0) AS total
    FROM exchange_positions
    WHERE trading_strategy_id = ? AND status = 'settled'
  `).get(strategyId)

  return round(Number(row?.total ?? 0))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
