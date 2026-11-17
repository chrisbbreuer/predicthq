import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { requestBoolean } from '../../Support/request-input'
import { response } from '@stacksjs/router'
import { executeStrategy, type Strategy } from '../../Services/trading/execute'

/**
 * POST /api/trading/decisions/{id}/review — approve or reject by hand.
 *
 * This is the whole manual path: on a plan without automated execution,
 * or a strategy left on manual, decisions queue here and a person
 * decides. Approving runs the same executor the schedule uses, so the
 * risk checks apply identically — the difference between the two paths
 * is who initiated it, and nothing else.
 */
/** Beyond this a queued decision can be skipped but not placed. */
const APPROVAL_MAX_AGE_HOURS = 6

export default {
  name: 'ReviewDecision',
  description: 'Approve a queued decision (placing its order) or reject it.',

  async handle(request?: {
    get?: (key: string) => string | undefined
    param?: (key: string) => string | undefined
    user?: { id?: number }
  }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to review decisions.', 401)

    const decisionId = Number(request?.param?.('id') ?? 0) || 0
    if (!decisionId)
      return response.error('A decision id is required.', 422)

    const approve = requestBoolean(request, 'approve', true)
    const db = new Database()

    try {
      const decision = await db.prepare<{ id: number, status: string, trading_strategy_id: number, user_id: number, created_at: string }>(`
        SELECT d.id, d.status, d.trading_strategy_id, s.user_id, d.created_at
        FROM trade_decisions d
        JOIN trading_strategies s ON s.id = d.trading_strategy_id
        WHERE d.id = ?
      `).get(decisionId)

      if (!decision || decision.user_id !== userId)
        return response.error('Decision not found.', 404)

      // Reviewing something already executed would place a second order
      // against a position that exists — the one outcome a review screen
      // must never produce.
      if (decision.status === 'executed' || decision.status === 'failed')
        return response.error(`This decision is already ${decision.status}.`, 409)

      const now = new Date().toISOString()

      if (!approve) {
        await db.prepare(`UPDATE trade_decisions SET status = 'rejected', status_reason = 'rejected by user', updated_at = ? WHERE id = ?`)
          .run(now, decisionId)

        return { id: decisionId, status: 'rejected' }
      }

      // A decision carries the price and evidence of the moment it was made.
      // Hours later that moment is gone, so approving it would place an
      // order on reasoning that no longer holds. Refuse, and say why.
      const madeAt = Date.parse(`${String(decision.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')}`)
      if (Number.isFinite(madeAt) && Date.now() - madeAt > APPROVAL_MAX_AGE_HOURS * 3600_000)
        return response.error('This decision is too old to place: the price and evidence behind it have moved on. Skip it and let the strategy decide again.', 409)

      const strategy = await loadStrategyForReview(db, decision.trading_strategy_id)

      if (!strategy)
        return response.error('The strategy behind this decision no longer exists.', 404)

      // A manual approval IS the intent to execute this one order, so the
      // executor's `auto_execute` gate is satisfied for this call only —
      // the stored strategy setting is untouched. Every other check
      // (entitlement, bankroll, position cap, venue health) still runs.
      const outcomes = await executeStrategy(db, { ...strategy, auto_execute: 1 }, [decisionId])
      const outcome = outcomes[0]

      return {
        id: decisionId,
        status: outcome?.placed ? 'executed' : 'skipped',
        reason: outcome?.reason ?? 'no outcome returned',
      }
    }
    finally {
      db.close()
    }
  },
}

/** Kept separate so the paper/live boundary has a direct regression test. */
export async function loadStrategyForReview(db: Database, strategyId: number): Promise<Strategy | null> {
  return await db.prepare<Strategy>(`
    SELECT id, user_id, venue, bankroll, max_stake, min_edge, min_confidence,
          max_open_positions, daily_loss_limit, cumulative_loss_limit,
          auto_execute, status, mode
    FROM trading_strategies WHERE id = ?
  `).get(strategyId)
}
