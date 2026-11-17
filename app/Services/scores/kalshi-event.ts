import type { GameDetail } from './espn'
import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import { cached, kalshiEventMarkets, kalshiSeriesOpenMarkets } from '../prediction-markets/kalshi-public'
import { findGame } from '../odds/books/exchange-games'
import { gamesOn, parseGameTicker } from '../trading/live-games'

/**
 * The Kalshi winner market for an ESPN game, when Kalshi lists one.
 *
 * Kalshi names game events `{SERIES}-{YYMONDD}{AWAY}{HOME}` in Eastern
 * time, with its own team codes. Those mostly match ESPN's and differ in
 * a known handful (GS/GSW, NO/NOP, WSH/WAS), so the event is found by
 * trying the few spellings that can apply rather than by searching the
 * catalogue. Each probe is a listing that comes back empty when wrong,
 * and the answer, found or not, is cached per game.
 */

const WINNER_SERIES: Record<string, string> = {
  'nba': 'KXNBAGAME',
  'wnba': 'KXWNBAGAME',
  'nfl': 'KXNFLGAME',
  'ncaaf': 'KXNCAAFGAME',
  'ncaab': 'KXNCAAMBGAME',
  'ncaaw': 'KXNCAAWBGAME',
  'nhl': 'KXNHLGAME',
  'mlb': 'KXMLBGAME',
  'mls': 'KXMLSGAME',
  'epl': 'KXEPLGAME',
  'ucl': 'KXUCLGAME',
  'uefa-nations': 'KXUEFANLGAME',
  'laliga': 'KXLALIGAGAME',
  'seriea': 'KXSERIEAGAME',
  'bundesliga': 'KXBUNDESLIGAGAME',
  'ligue1': 'KXLIGUE1GAME',
}

const KALSHI_SPELLINGS: Record<string, string[]> = {
  GS: ['GSW'],
  NO: ['NOP'],
  NY: ['NYK'],
  SA: ['SAS'],
  UTAH: ['UTA'],
  WSH: ['WAS'],
  LA: ['LAK', 'LAR'],
  NJ: ['NJD'],
  SJ: ['SJS'],
  TB: ['TBL'],
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Kalshi's `YYMONDD` for a start time, in US Eastern. */
export function kalshiDate(startsAt: string): string | null {
  const at = new Date(startsAt)
  if (!Number.isFinite(at.getTime()))
    return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: '2-digit', month: 'numeric', day: '2-digit' }).formatToParts(at)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}${MONTHS[Number(get('month')) - 1]}${get('day')}`
}

function spellings(abbreviation: string): string[] {
  const own = abbreviation.toUpperCase().replace(/[^A-Z]/g, '')
  return own ? [own, ...(KALSHI_SPELLINGS[own] ?? [])] : []
}

/** Candidate event tickers, most likely first. */
export function candidateEvents(league: string, game: Pick<GameDetail, 'away' | 'home'> & { startsAt?: string }): string[] {
  const series = WINNER_SERIES[league]
  const date = game.startsAt ? kalshiDate(game.startsAt) : null
  if (!series || !date)
    return []
  const out: string[] = []
  for (const away of spellings(game.away.abbreviation)) {
    for (const home of spellings(game.home.abbreviation))
      out.push(`${series}-${date}${away}${home}`)
  }
  return out.slice(0, 6)
}

export interface GameMarket {
  eventTicker: string
  /** The winner markets, one per side (and a tie, in soccer). */
  tickers: string[]
}

export function kalshiEventFor(league: string, gameId: string, game: Pick<GameDetail, 'away' | 'home'> & { startsAt?: string }): Promise<GameMarket | null> {
  return cached(`kalshi-event:${league}:${gameId}`, 10 * 60_000, async () => {
    for (const eventTicker of candidateEvents(league, game)) {
      const markets = await kalshiEventMarkets(eventTicker).catch(() => [])
      if (markets.length > 0)
        return { eventTicker, tickers: markets.map(market => market.ticker) }
    }
    return await eventFromSeries(league, gameId)
  })
}

/**
 * The game's event found by reading the series and matching each listed
 * game to ESPN, the way the odds adapters do.
 *
 * Guessing the ticker from ESPN's abbreviations works for pro teams and
 * fails for college ones: Kalshi writes Notre Dame at Florida as `FLAND`,
 * where ESPN has `ND` and `FLA` in the other order. Matching the series'
 * own tickers against the day's ESPN games handles both.
 */
async function eventFromSeries(league: string, gameId: string): Promise<GameMarket | null> {
  const series = WINNER_SERIES[league]
  if (!series)
    return null
  const markets = await kalshiSeriesOpenMarkets(series).catch(() => [] as KalshiMarketInfo[])
  const byEvent = new Map<string, KalshiMarketInfo[]>()
  for (const market of markets) {
    const list = byEvent.get(market.eventTicker) ?? []
    list.push(market)
    byEvent.set(market.eventTicker, list)
  }
  for (const [eventTicker, outcomes] of byEvent) {
    const ref = parseGameTicker(outcomes[0]!.ticker)
    if (!ref || ref.league !== league)
      continue
    const games = await gamesOn(league, ref.date).catch(() => [])
    const game = findGame(league, ref.date, ref.code, games, outcomes.map(outcome => outcome.yesSubTitle).filter(Boolean))
    if (game?.id === gameId)
      return { eventTicker, tickers: outcomes.map(outcome => outcome.ticker) }
  }
  return null
}
