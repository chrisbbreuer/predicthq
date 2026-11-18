import type { RequestLike } from '../../Support/api'
import { freshness, ok, Params } from '../../Support/api'
import { loadBoard } from '../../Support/odds'

/**
 * GET /api/v1/arbitrage — markets where line-shopping guarantees a profit.
 *
 * Arbitrage is a property of a *market*, not an event: only selections
 * within one market at one line are mutually exclusive, so summing implied
 * probabilities across an event's moneyline and its total produces a
 * meaningless number. The previous endpoint summed per event, which on a
 * multi-market event reported arbitrage that did not exist.
 */
export default {
  name: 'V1GetArbitrage',
  description: 'Markets that currently offer a cross-book arbitrage.',

  async handle(request?: RequestLike) {
    const params = new Params(request)
    const sport = params.string('sport', { max: 40 })
    const minProfit = params.int('minProfit', { min: 0, max: 100, default: 0 })!
    const limit = params.int('limit', { min: 1, max: 200, default: 50 })!

    const invalid = params.invalid()
    if (invalid)
      return invalid

    const board = await loadBoard({ sport, status: 'scheduled', limit: 200, historyPoints: 0 })

    const opportunities = []
    for (const event of board.events) {
      for (const market of event.markets) {
        if (!market.hold?.isArbitrage || market.hold.arbitragePct < minProfit)
          continue
        const hold = market.hold

        opportunities.push({
          event: { id: event.id, title: event.title, league: event.league, sport: event.sport, commenceAt: event.commenceAt },
          market: { id: market.id, type: market.marketType, label: market.label, line: market.line },
          profitPct: hold.arbitragePct,
          impliedSum: hold.bestBookSum,
          legs: market.selections.map(s => ({
            label: s.label,
            side: s.side,
            point: s.point,
            price: s.bestPrice,
            bookmaker: board.bookmakers.find(b => b.id === s.bestBookmakerId)?.name ?? null,
            // The share of the total stake this leg takes to lock the
            // profit. Without it the caller has a signal but not a bet.
            stakeShare: s.bestPrice && hold.bestBookSum > 0
              ? (1 / s.bestPrice) / hold.bestBookSum
              : 0,
          })),
        })
      }
    }

    opportunities.sort((a, b) => b.profitPct - a.profitPct)

    return ok(opportunities.slice(0, limit), {
      // Arbitrage windows close in seconds. A cached one is a lie, so this
      // endpoint is the one place that opts out of caching entirely.
      cacheSeconds: 0,
      meta: { freshness: await freshness(), count: opportunities.length },
    })
  },
}
