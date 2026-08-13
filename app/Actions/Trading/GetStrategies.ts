import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { resolveEntitlements } from '../../Services/billing/entitlements'

interface StrategyRow {
  id: number
  name: string
  venue: string
  mode: string | null
  categories: string
  bankroll: number
  max_stake: number
  min_edge: number
  min_confidence: number
  max_open_positions: number
  daily_loss_limit: number
  cumulative_loss_limit: number
  auto_execute: number
  status: string
  halted_reason: string
  last_run_at: string
  working_orders: number
  open_positions: number
  committed: number
}

/**
 * GET /api/trading/strategies — a user's strategies and where they stand.
 *
 * The live exposure numbers are joined in rather than left to the client
 * to compute: how much a strategy has committed against its bankroll is
 * the single thing a user checks, and a UI that has to derive it is a UI
 * that will derive it differently from the executor.
 */
export default {
  name: 'GetStrategies',
  description: 'Trading strategies with their current exposure and plan entitlements.',

  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to view strategies.', 401)

    const db = new Database()

    try {
      const strategies = await db.prepare<StrategyRow>(`
        SELECT
          s.id, s.name, s.venue, s.mode, s.categories, s.bankroll, s.max_stake, s.min_edge,
          s.min_confidence, s.max_open_positions, s.daily_loss_limit, s.auto_execute,
          s.cumulative_loss_limit, s.status, s.halted_reason, s.last_run_at,
          COALESCE(o.working_orders, 0) AS working_orders,
          COALESCE(p.open_positions, 0) AS open_positions,
          COALESCE(o.working, 0) + COALESCE(p.at_risk, 0) AS committed
        FROM trading_strategies s
        -- Only the unfilled remainder of a working order. Whatever has
        -- filled is already carried by the position it created, and
        -- counting both is how a bankroll appears fully committed at
        -- half the exposure.
        LEFT JOIN (
          SELECT
            d.trading_strategy_id AS sid,
            COUNT(*) AS working_orders,
            SUM(eo.limit_price * (eo.size - COALESCE(eo.accrued_size, 0))) AS working
          FROM exchange_orders eo
          JOIN trade_decisions d ON d.id = eo.trade_decision_id
          WHERE eo.status IN ('pending', 'open', 'partial')
          GROUP BY d.trading_strategy_id
        ) AS o ON o.sid = s.id
        LEFT JOIN (
          SELECT
            trading_strategy_id AS sid,
            COUNT(*) AS open_positions,
            SUM(cost_basis) AS at_risk
          FROM exchange_positions
          WHERE status = 'open' AND size > 0
          GROUP BY trading_strategy_id
        ) AS p ON p.sid = s.id
        WHERE s.user_id = ?
        ORDER BY s.id
      `).all(userId)

      const entitlements = await resolveEntitlements(db, userId)

      return {
        userId,
        entitlements,
        count: strategies.length,
        strategies: strategies.map(s => ({
          id: s.id,
          name: s.name,
          venue: s.venue,
          // Absent means live, matching how the executor reads it.
          mode: s.mode === 'paper' ? 'paper' : 'live',
          categories: s.categories ? s.categories.split(',').map(c => c.trim()).filter(Boolean) : [],
          bankroll: s.bankroll,
          maxStake: s.max_stake,
          minEdge: s.min_edge,
          minConfidence: s.min_confidence,
          maxOpenPositions: s.max_open_positions,
          dailyLossLimit: s.daily_loss_limit,
          cumulativeLossLimit: s.cumulative_loss_limit,
          autoExecute: s.auto_execute === 1,
          status: s.status,
          haltedReason: s.halted_reason,
          lastRunAt: s.last_run_at,
          workingOrders: s.working_orders,
          openPositions: s.open_positions,
          committed: Math.round(s.committed * 100) / 100,
          bankrollRemaining: Math.round((s.bankroll - s.committed) * 100) / 100,
        })),
      }
    }
    finally {
      db.close()
    }
  },
}
