import type { LiveGame } from '../../Services/trading/live-games'
import type { ParlayTracker } from '../../Services/trading/book-tracking'
import { response } from '@stacksjs/router'
import { kalshiChart, parseRange } from '../../Services/prediction-markets/kalshi-chart'
import { currentPrice, kalshiMarket, KalshiPublicError } from '../../Services/prediction-markets/kalshi-public'
import { trackParlay } from '../../Services/trading/book-tracking'
import { liveGameFor } from '../../Services/trading/live-games'

/**
 * GET /api/markets/kalshi/{ticker}?range=live|1d|1w|1m|all&side=yes|no
 *
 * One Kalshi market as the bet page draws it: its probability history,
 * the game it is about with the live score, and, for a parlay, every leg.
 *
 * Public on purpose. It reads only Kalshi's public catalogue and ESPN's
 * public scoreboard, so it reveals nothing about who holds the market —
 * the private half (size, cost, P&L) stays behind `/api/trading/positions`.
 * Throttled at the route, and every upstream read is cached, so a page
 * polling it costs Kalshi one request per cache window however many tabs
 * are open.
 */

const TICKER = /^[A-Z0-9][A-Z0-9._-]{2,120}$/i

interface ParamRequest {
  getParam?: (key: string) => string | undefined
  get?: (key: string) => string | undefined
}

export default {
  name: 'GetKalshiMarket',
  description: 'A Kalshi market with its probability history, live game, and parlay legs.',

  async handle(request?: ParamRequest) {
    const ticker = String(request?.getParam?.('ticker') ?? '').trim().toUpperCase()
    if (!TICKER.test(ticker))
      return response.error('Unknown market.', 422)

    const range = parseRange(request?.get?.('range'))
    const side = String(request?.get?.('side') ?? 'yes').toLowerCase() === 'no' ? 'no' : 'yes'

    try {
      const market = await kalshiMarket(ticker)
      const parlay: ParlayTracker | null = market.legs.length > 0 ? await trackParlay(market).catch(() => null) : null
      const game: LiveGame | null = parlay ? null : await liveGameFor(ticker, side, undefined, market.yesSubTitle).catch(() => null)
      const chart = await kalshiChart(ticker, range, { liveSince: game?.startsAt ?? null })

      return {
        asOf: new Date().toISOString(),
        market: {
          ticker: market.ticker,
          eventTicker: market.eventTicker,
          title: market.title,
          outcomeLabel: market.yesSubTitle,
          noLabel: market.noSubTitle,
          status: market.status,
          result: market.result,
          price: currentPrice(market),
          lastPrice: market.lastPrice,
          yesBid: market.yesBid,
          yesAsk: market.yesAsk,
          volume: market.volume,
          occursAt: market.occursAt,
          closeTime: market.closeTime,
          url: `https://kalshi.com/markets/${encodeURIComponent(market.eventTicker.split('-')[0]?.toLowerCase() ?? '')}`,
        },
        game,
        parlay,
        chart,
      }
    }
    catch (error) {
      if (error instanceof KalshiPublicError && error.status === 404)
        return response.error('Kalshi has no market with that ticker.', 404)
      return response.error('Kalshi did not answer. Try again in a moment.', 502)
    }
  },
}
