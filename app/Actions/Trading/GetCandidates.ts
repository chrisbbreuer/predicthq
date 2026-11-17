import { Database } from '../../Support/db'
import { buildCandidates } from '../../Services/trading/evidence'
import { liveGameForTicker } from '../../Services/trading/live-games'

/**
 * GET /api/trading/candidates — what the model would look at right now.
 *
 * A dry read of the evidence layer with nothing persisted and no venue
 * contacted. This is what makes the quantitative side inspectable
 * without arming a strategy: the same function the trading loop calls,
 * returning the same numbers, from a request that cannot place a trade.
 */
export default {
  name: 'GetCandidates',
  description: 'Live trade candidates with their evidence, computed but not persisted.',

  async handle(request?: { get?: (key: string) => string | undefined }) {
    const venue = request?.get?.('venue') ?? ''
    const category = request?.get?.('category') ?? ''
    const minEdge = Number(request?.get?.('minEdge') ?? 0.03) || 0.03
    const limit = Math.min(100, Number(request?.get?.('limit') ?? 25) || 25)

    const db = new Database()

    try {
      const candidates = await buildCandidates(db, {
        venues: venue ? [venue] : [],
        categories: category ? [category] : [],
        minEdge,
        limit,
        gameFor: liveGameForTicker,
      })

      return { count: candidates.length, minEdge, candidates }
    }
    finally {
      db.close()
    }
  },
}
