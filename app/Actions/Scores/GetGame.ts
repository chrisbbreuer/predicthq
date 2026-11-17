import { response } from '@stacksjs/router'
import { Database } from '../../Support/db'
import { kalshiChart, parseRange } from '../../Services/prediction-markets/kalshi-chart'
import { kalshiEventMarkets } from '../../Services/prediction-markets/kalshi-public'
import { gameBoard } from '../../Services/scores/game-board'
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
    const range = parseRange(request?.get?.('range'))
    const [chart, outcomes, board] = await Promise.all([
      market
        ? kalshiChart(market.tickers[0]!, range, { liveSince: game.state === 'pre' ? null : game.startsAt ?? null }).catch(() => null)
        : Promise.resolve(null),
      market ? kalshiEventMarkets(market.eventTicker).catch(() => []) : Promise.resolve([]),
      boardFor(id),
    ])
    // Every contract trades on exactly one outcome's market, so the event's
    // volume is the sum across its outcomes.
    const volume = outcomes.reduce((sum, outcome) => sum + (Number(outcome.volume) || 0), 0)

    return {
      asOf: new Date().toISOString(),
      game,
      kalshi: market && chart ? { eventTicker: market.eventTicker, tickers: market.tickers, chart, range, volume } : null,
      board,
    }
  },
}

/** The game's prices from our own odds feed, or null when it has none. */
async function boardFor(espnId: string) {
  const db = new Database()
  try {
    return await gameBoard(db, espnId)
  }
  catch {
    return null
  }
  finally {
    db.close()
  }
}
