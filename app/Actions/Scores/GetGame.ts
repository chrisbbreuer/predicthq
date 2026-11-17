import { response } from '@stacksjs/router'
import { kalshiChart, parseRange } from '../../Services/prediction-markets/kalshi-chart'
import { isKnownLeague } from '../../Services/scores/espn'
import { kalshiEventFor } from '../../Services/scores/kalshi-event'
import { gameDetail } from '../../Services/trading/leg-progress'

/**
 * GET /api/scores/{league}/game/{id}?range=live
 *
 * One game for the game page: score, clock, last play, line score, player
 * box scores, team stats, the book's line, and — when Kalshi lists the
 * game — its win-probability chart. Public data only; cached upstream so
 * a page polling it while the game is on costs one ESPN read per window.
 */

interface ParamRequest {
  getParam?: (key: string) => string | undefined
  get?: (key: string) => string | undefined
}

export default {
  name: 'GetGame',
  description: 'One game with its box score and Kalshi win probability.',

  async handle(request?: ParamRequest) {
    const league = String(request?.getParam?.('league') ?? '').toLowerCase()
    const id = String(request?.getParam?.('id') ?? '')
    if (!isKnownLeague(league) || !/^\d{1,20}$/.test(id))
      return response.error('Unknown game.', 404)

    const game = await gameDetail(league, id).catch(() => null)
    if (!game)
      return response.error('ESPN has no game with that id.', 404)

    const market = await kalshiEventFor(league, id, game).catch(() => null)
    const chart = market
      ? await kalshiChart(market.tickers[0]!, parseRange(request?.get?.('range')), { liveSince: game.state === 'pre' ? null : game.startsAt ?? null }).catch(() => null)
      : null

    return {
      asOf: new Date().toISOString(),
      game,
      kalshi: market && chart ? { eventTicker: market.eventTicker, tickers: market.tickers, chart } : null,
    }
  },
}
