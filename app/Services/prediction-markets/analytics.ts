import { Database } from '../../Support/db'

/**
 * Winning-pattern analytics over the ingested prediction-market tape.
 *
 * Two passes, both plain SQL over the ingest tables:
 *
 * 1. Score fills — once a market settles, every unscored fill on it is
 *    marked won/lost by comparing the side bought to the market result.
 * 2. Aggregate traders — per attributable trader (Polymarket wallets),
 *    recompute volume, sizing, win rate and a smart-money score.
 *
 * The smart score answers "how much should we trust this account's next
 * buy?": a Bayesian-shrunk win rate (so 2/2 doesn't beat 40/50) scaled
 * by how much evidence exists, mapped to 0..100.
 */

/** Trades ≥ this notional (USD) mark the account as a whale. */
const WHALE_SINGLE_TRADE = 10_000
/** Total notional (USD) beyond which an account is a whale regardless of sizing. */
const WHALE_TOTAL_NOTIONAL = 100_000
/** Pseudo-observations pulled toward 50% when shrinking win rates. */
const PRIOR_WEIGHT = 6
/** Keep every result set well below Vitess's 10,000-row response ceiling. */
const ANALYTICS_BATCH = 2_000

export interface AnalyticsSummary {
  scoredTrades: number
  tradersUpdated: number
  whales: number
}

export async function runAnalytics(db: Database, touchedTraderIds?: readonly number[]): Promise<AnalyticsSummary> {
  const now = new Date().toISOString()

  const pending = await db.query<{ id: number, market_trader_id: number | null, side: string, result: string }>(`
    SELECT t.id, t.market_trader_id, t.side, pm.result
    FROM market_trades t
    JOIN prediction_markets pm ON pm.id = t.prediction_market_id
    WHERE t.is_winner = -1 AND pm.status = 'settled' AND pm.result != ''
    ORDER BY t.id
    LIMIT ?
  `).all(ANALYTICS_BATCH)

  // Pass 2 — recompute aggregates for every attributable trader. The smart
  // score shrinks the raw win rate toward 0.5 with PRIOR_WEIGHT pseudo-trades
  // then rescales 0.5..1 → 0..100, so only sustained above-coin-flip
  // accuracy earns a high score.
  await db.transaction(async (transaction) => {
    for (const trade of pending) {
      await transaction.prepare('UPDATE market_trades SET is_winner = ?, updated_at = ? WHERE id = ?')
        .run(trade.side === trade.result ? 1 : 0, now, trade.id)
    }
  })

  // A scheduled ingest only needs to recompute traders whose tape changed or
  // whose old fill was just scored. The optional-argument form still supports
  // manual/backfill runs, but selects a bounded tranche instead of returning
  // every wallet in a multi-million-fill database at once.
  const traderIds = new Set<number>(touchedTraderIds)
  for (const trade of pending) {
    if (trade.market_trader_id !== null)
      traderIds.add(Number(trade.market_trader_id))
  }

  if (touchedTraderIds === undefined) {
    const tranche = await db.query<{ id: number }>('SELECT id FROM market_traders ORDER BY id LIMIT ?').all(ANALYTICS_BATCH)
    for (const trader of tranche)
      traderIds.add(Number(trader.id))
  }

  const ids = [...traderIds].filter(Number.isFinite)
  const aggregates = ids.length === 0 ? [] : await db.query<{
    tid: number
    n: number
    total: number
    avg_size: number
    max_size: number
    resolved: number
    wins: number
  }>(`
    SELECT market_trader_id AS tid, COUNT(*) AS n, SUM(notional) AS total,
          AVG(notional) AS avg_size, MAX(notional) AS max_size,
          SUM(CASE WHEN is_winner != -1 THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN is_winner = 1 THEN 1 ELSE 0 END) AS wins
    FROM market_trades
    WHERE market_trader_id IN (${ids.map(() => '?').join(', ')})
    GROUP BY market_trader_id
  `).all(...ids)

  await db.transaction(async (transaction) => {
    for (const row of aggregates) {
      const resolved = Number(row.resolved || 0)
      const wins = Number(row.wins || 0)
      const winRate = resolved > 0 ? wins / resolved : 0
      const smartScore = Math.max(0, Math.min(100, Math.round((((wins + PRIOR_WEIGHT * 0.5) / (resolved + PRIOR_WEIGHT)) - 0.5) * 2000) / 10))
      await transaction.prepare(`
        UPDATE market_traders SET trade_count = ?, total_notional = ?, avg_trade_size = ?, max_trade_size = ?,
          resolved_trade_count = ?, winning_trade_count = ?, win_rate = ?, smart_score = ?, is_whale = ?, updated_at = ?
        WHERE id = ?
      `).run(row.n, row.total, row.avg_size, row.max_size, resolved, wins, winRate, smartScore,
        row.max_size >= WHALE_SINGLE_TRADE || row.total >= WHALE_TOTAL_NOTIONAL ? 1 : 0, now, row.tid)
    }
  })

  const whales = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM market_traders WHERE is_whale = 1').get()

  return {
    scoredTrades: pending.length,
    tradersUpdated: aggregates.length,
    whales: Number(whales?.c ?? 0),
  }
}
