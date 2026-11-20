import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { OddsPapiTotalPair } from './oddspapi-checkpoints'
import { kalshiEventMarkets } from '../prediction-markets/kalshi-public'
import { parseGameTicker } from './live-games'

const totalSeries: Record<string, string> = {
  nba: 'KXNBATOTAL',
  wnba: 'KXWNBATOTAL',
  nfl: 'KXNFLTOTAL',
  nhl: 'KXNHLTOTAL',
  mlb: 'KXMLBTOTAL',
  ncaab: 'KXNCAAMBTOTAL',
  ncaaw: 'KXNCAAWBTOTAL',
  ncaaf: 'KXNCAAFTOTAL',
}

export interface KalshiTotalQuote {
  ticker: string
  line: number
  bidOver: number
  askOver: number
  bidUnder: number
  askUnder: number
  checkedAt: number
}

export interface TotalCheckpoint {
  sportsbook: OddsPapiTotalPair[]
  kalshi: KalshiTotalQuote[]
}

export function capturedTotal(quote: KalshiMarketInfo, checkedAt: number): KalshiTotalQuote | null {
  const { ticker, floorStrike, strikeType, yesBid, yesAsk, noBid, noAsk } = quote
  // A binary 'greater' market on a half-point has the same over/under
  // boundary as a book's game total, including when there is no exact pair.
  if (!(quote.status === 'active' || quote.status === 'open') || strikeType !== 'greater'
    || floorStrike == null || floorStrike % 1 !== .5 || !/^over\b/i.test(quote.yesSubTitle.trim())
    || yesBid == null || yesAsk == null || noBid == null || noAsk == null
    || !(yesBid > 0 && yesAsk >= yesBid && yesAsk < 1 && noBid > 0 && noAsk >= noBid && noAsk < 1))
    return null
  return { ticker, line: floorStrike, bidOver: yesBid, askOver: yesAsk, bidUnder: noBid, askUnder: noAsk, checkedAt }
}

export async function loadKalshiGameTotals(
  ticker: string,
  startsAt: number,
  now = Date.now,
  load = kalshiEventMarkets,
): Promise<KalshiTotalQuote[]> {
  const event = parseGameTicker(ticker)
  const series = event && totalSeries[event.league]
  if (!series)
    return []
  const marketEvent = series + event.eventTicker.slice(event.series.length)
  const quotes = await load(marketEvent, 0).catch(() => [])
  const checkedAt = now()
  if (startsAt - checkedAt < 30 * 60_000 || startsAt - checkedAt > 40 * 60_000)
    return []
  return quotes.filter(quote => quote.eventTicker === marketEvent)
    .map(quote => capturedTotal(quote, checkedAt)).filter(quote => quote !== null)
}
