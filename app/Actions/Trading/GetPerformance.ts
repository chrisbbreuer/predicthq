import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { performanceForUser, strategyPerformance } from '../../Services/trading/performance'

/**
 * GET /api/trading/performance — what the strategies actually returned.
 *
 * Every other trading endpoint describes intent: what the engine is
 * looking at, what it decided, what it holds. This one describes outcome,
 * which is the only one a user can use to decide whether to keep paying
 * for the others.
 *
 * Paper and live strategies answer here identically, because they book
 * into the same positions and settle by the same rule. That is the whole
 * argument for paper mode: the track record it produces is comparable to
 * the real one rather than adjacent to it.
 */
export default {
  name: 'GetPerformance',
  description: 'Realized results, hit rate, and drawdown per trading strategy.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to view strategy performance.', 401)

    const db = new Database()

    try {
      const id = Number(request?.get?.('strategyId') ?? 0) || 0

      if (id) {
        // Ownership is checked before the numbers are computed rather
        // than after: a 404 that took a few queries to produce still
        // tells the caller the strategy exists.
        const owned = await db.prepare<{ id: number }>(
          'SELECT id FROM trading_strategies WHERE id = ? AND user_id = ?',
        ).get(id, userId)

        if (!owned)
          return response.error('Strategy not found.', 404)

        return { strategies: [await strategyPerformance(db, id)] }
      }

      const strategies = await performanceForUser(db, userId)

      return {
        count: strategies.length,
        // The portfolio view. Summed rather than averaged: a user with
        // one strategy up $50 and another down $80 is down $30, and an
        // average return would report them as roughly flat.
        totals: {
          settled: strategies.reduce((sum, s) => sum + s.settled, 0),
          realized: round(strategies.reduce((sum, s) => sum + s.realized, 0)),
          invested: round(strategies.reduce((sum, s) => sum + s.invested, 0)),
          openCost: round(strategies.reduce((sum, s) => sum + s.openCost, 0)),
        },
        strategies,
      }
    }
    finally {
      db.close()
    }
  },
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
