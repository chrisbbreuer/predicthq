import type { Database } from '../../Support/db'
import type { GameDetail } from '../scores/espn'
import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { LiveGame } from './live-games'
import { fetchGame } from '../scores/espn'
import { kalshiMarkets, kalshiSeriesOpenMarkets } from '../prediction-markets/kalshi-public'
import { SERIES } from '../odds/books/kalshi'
import { kalshiFee } from './backtest'
import { tradablePrice } from './evidence'
import { liveGameFor, parseGameTicker } from './live-games'

/**
 * Kalshi against the sportsbook line, recorded going forward.
 *
 * Soccer is recorded too: its line is three-way, so the draw shares the margin
 * and Kalshi's tie market is compared with the book's draw.
 *
 * Replaying 1,077 past games against ESPN's DraftKings line looked like an
 * edge (+13% on 2-point gaps in both halves), but ESPN keeps only the closing
 * line, and at tip-off Kalshi already agrees with it (Brier 0.1824 vs 0.1822,
 * almost no 2-point gaps). The past can't say whether the line *as it stood*
 * leads Kalshi, so this records both at the same moment, every five minutes,
 * and `linesReport` scores "buy Kalshi where the book disagrees" once the
 * games settle.
 */

/** Every game-winner series we price, soccer included, plus women's college basketball. */
export const LINE_SERIES = [...new Set([...Object.values(SERIES), 'KXNCAAWBGAME'])]

export type LineSide = 'home' | 'away' | 'draw'

/** How far ahead of the start a game is worth recording. */
const WINDOW_MINUTES = 180

/** American odds to implied probability. */
export function impliedFromAmerican(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100)
}

/**
 * The book's probability for `side`, margin removed, or null when the prices
 * do not look like a real moneyline. A soccer line is three-way: the draw is
 * priced too, and all three share the margin.
 */
export function bookProbability(home: number | null, away: number | null, side: LineSide, draw: number | null = null): number | null {
  if (!home || !away)
    return null
  const h = impliedFromAmerican(home)
  const a = impliedFromAmerican(away)
  const d = draw ? impliedFromAmerican(draw) : 0
  if (side === 'draw' && !draw)
    return null
  const total = h + a + d
  // A real line carries a few percent of margin (more on three outcomes), never less than none.
  if (total < 0.98 || total > (draw ? 1.25 : 1.15))
    return null
  return (side === 'home' ? h : side === 'away' ? a : d) / total
}

export interface RecordDeps {
  openMarkets: (series: string) => Promise<KalshiMarketInfo[]>
  gameFor: (ticker: string) => Promise<LiveGame | null>
  detailFor: (league: string, gameId: string) => Promise<GameDetail | null>
  now: () => number
}

const defaultDeps: RecordDeps = {
  openMarkets: series => kalshiSeriesOpenMarkets(series),
  gameFor: ticker => liveGameFor(ticker, 'yes'),
  detailFor: fetchGame,
  now: () => Date.now(),
}

export async function recordLines(db: Database, deps: RecordDeps = defaultDeps): Promise<{ recorded: number, games: number }> {
  const now = deps.now()
  const details = new Map<string, Promise<GameDetail | null>>()
  let recorded = 0

  for (const series of LINE_SERIES) {
    const markets = await deps.openMarkets(series).catch(() => [] as KalshiMarketInfo[])
    for (const market of markets) {
      const { yesBid: bid, yesAsk: ask } = market
      if (bid === null || ask === null || ask <= 0 || ask - bid > 0.1)
        continue
      const game = await deps.gameFor(market.ticker).catch(() => null)
      // A soccer tie market names no team; it pays on the draw.
      const side: LineSide | null = game?.selected ?? (parseGameTicker(market.ticker)?.outcome === 'TIE' ? 'draw' : null)
      if (!game || game.state !== 'pre' || !side)
        continue
      const minutes = Math.round((Date.parse(game.startsAt) - now) / 60_000)
      if (!(minutes >= 0 && minutes <= WINDOW_MINUTES))
        continue

      const key = `${game.league}:${game.gameId}`
      if (!details.has(key))
        details.set(key, deps.detailFor(game.league, game.gameId).catch(() => null))
      const odds = (await details.get(key))?.odds
      const prob = bookProbability(odds?.homeMoneyLine ?? null, odds?.awayMoneyLine ?? null, side, odds?.drawMoneyLine ?? null)
      if (prob === null)
        continue

      const stamp = new Date(now).toISOString()
      await db.query(`
        INSERT INTO line_snapshots (ticker, league, espn_game_id, side, provider, book_prob, kalshi_bid, kalshi_ask, minutes_to_start, starts_at, recorded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(market.ticker, game.league, game.gameId, side, odds?.provider ?? '', Math.round(prob * 10000) / 10000, bid, ask, minutes, game.startsAt, stamp, stamp, stamp)
      recorded++
    }
  }

  return { recorded, games: details.size }
}

export interface LineBet {
  ticker: string
  day: string
  side: 'yes' | 'no'
  price: number
  bookProb: number
  kalshiMid: number
  won: boolean
  pnl: number
}

export interface LinesReport {
  games: number
  settled: number
  brier: { kalshi: number | null, book: number | null }
  gap: number
  bets: LineBet[]
  roi: number | null
  daysUp: number
  days: number
}

/**
 * Score the recordings: one decision per game, from the snapshot closest to
 * thirty minutes before the start, buying Kalshi at the ask on the side the
 * book favours by at least `gap`, inside the tradable price band, with
 * Kalshi's fee. Unsettled games are left out.
 */
export async function linesReport(
  db: Database,
  options: { gap?: number, results?: (tickers: string[]) => Promise<Map<string, string>> } = {},
): Promise<LinesReport> {
  const gap = options.gap ?? 0.02
  const rows = await db.query<Record<string, unknown>>(`
    SELECT ticker, book_prob, kalshi_bid, kalshi_ask, minutes_to_start, starts_at
    FROM line_snapshots
    WHERE minutes_to_start BETWEEN 15 AND 60
  `).all()

  const best = new Map<string, { book: number, bid: number, ask: number, minutes: number, startsAt: string }>()
  for (const row of rows) {
    const ticker = String(row.ticker)
    const snap = { book: Number(row.book_prob), bid: Number(row.kalshi_bid), ask: Number(row.kalshi_ask), minutes: Number(row.minutes_to_start), startsAt: String(row.starts_at) }
    const held = best.get(ticker)
    if (!held || Math.abs(snap.minutes - 30) < Math.abs(held.minutes - 30))
      best.set(ticker, snap)
  }

  const results = await (options.results ?? settledResults)([...best.keys()])
  const bets: LineBet[] = []
  const kalshiErr: number[] = []
  const bookErr: number[] = []
  for (const [ticker, snap] of best) {
    const result = results.get(ticker)
    if (result !== 'yes' && result !== 'no')
      continue
    const outcome = result === 'yes' ? 1 : 0
    const mid = (snap.bid + snap.ask) / 2
    kalshiErr.push((mid - outcome) ** 2)
    bookErr.push((snap.book - outcome) ** 2)

    const diff = snap.book - mid
    if (Math.abs(diff) < gap)
      continue
    const side = diff > 0 ? 'yes' : 'no'
    const price = side === 'yes' ? snap.ask : 1 - snap.bid
    if (!tradablePrice(price))
      continue
    const won = (outcome === 1) === (side === 'yes')
    const contracts = 1 / price
    const pnl = (won ? contracts * (1 - price) : -1) - kalshiFee(contracts, price)
    bets.push({ ticker, day: snap.startsAt.slice(0, 10), side, price, bookProb: snap.book, kalshiMid: mid, won, pnl: Math.round(pnl * 100) / 100 })
  }

  const byDay = new Map<string, number>()
  for (const bet of bets) byDay.set(bet.day, (byDay.get(bet.day) ?? 0) + bet.pnl)
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10000) / 10000 : null

  return {
    games: best.size,
    settled: kalshiErr.length,
    brier: { kalshi: mean(kalshiErr), book: mean(bookErr) },
    gap,
    bets,
    roi: bets.length ? Math.round(bets.reduce((sum, bet) => sum + bet.pnl, 0) / bets.length * 1000) / 1000 : null,
    daysUp: [...byDay.values()].filter(pnl => pnl > 0).length,
    days: byDay.size,
  }
}

async function settledResults(tickers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < tickers.length; i += 100) {
    const markets = await kalshiMarkets(tickers.slice(i, i + 100), 60_000).catch(() => new Map<string, KalshiMarketInfo>())
    for (const [ticker, market] of markets) out.set(ticker, market.result)
  }
  return out
}
