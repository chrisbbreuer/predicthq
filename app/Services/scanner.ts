import type { Candidate } from './trading/evidence'
import type { KalshiCandle, KalshiMarketInfo } from './prediction-markets/kalshi-public'
import type { LiveGame } from './trading/live-games'
import { Database } from '../Support/db'
import { candlesToPoints } from './prediction-markets/kalshi-chart'
import { cached, currentPrice, kalshiCandles, toMarketInfo } from './prediction-markets/kalshi-public'
import { buildCandidates } from './trading/evidence'
import { liveGameFor, liveGameForTicker, parseGameTicker } from './trading/live-games'

/**
 * The live scanner: every game market on Kalshi that is in play or about
 * to be, with what it is priced at, how that price has been moving, how
 * much is trading, and what the model makes of it.
 *
 * It is a data view, not a tip sheet. Movement is reported as movement —
 * a price that fell twelve points in fifteen minutes has fallen, which is
 * worth knowing whichever way it should be read — and the model's view is
 * shown beside it with the evidence count that backs it, so a reader can
 * weigh both. Nothing here places or suggests an order.
 *
 * Cost control matters more than usual, because this is the widest read
 * in the product. Series listings and the model are cached for half a
 * minute; minute candles are read only for games actually in play, with a
 * small concurrency limit, and cached on the same window.
 */

const BASE = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'

const SERIES: Array<[string, string]> = [
  ['nba', 'KXNBAGAME'],
  ['nfl', 'KXNFLGAME'],
  ['ncaaf', 'KXNCAAFGAME'],
  ['ncaab', 'KXNCAAMBGAME'],
  ['ncaaw', 'KXNCAAWBGAME'],
  ['nhl', 'KXNHLGAME'],
  ['mlb', 'KXMLBGAME'],
  ['wnba', 'KXWNBAGAME'],
  ['epl', 'KXEPLGAME'],
  ['ucl', 'KXUCLGAME'],
  ['uefa-nations', 'KXUEFANLGAME'],
  ['laliga', 'KXLALIGAGAME'],
  ['seriea', 'KXSERIEAGAME'],
  ['bundesliga', 'KXBUNDESLIGAGAME'],
  ['mls', 'KXMLSGAME'],
]

const CACHE_MS = 30_000
const MOVE_FAST = 0.08
const WIDE_SPREAD = 0.05

export interface ScannerOutcome {
  ticker: string
  label: string
  price: number | null
  bid: number | null
  ask: number | null
  spread: number | null
  volume24h: number
  /** Change in the price over the window, in probability points. */
  change5m: number | null
  change15m: number | null
  change60m: number | null
  change24h: number | null
  /** Contracts traded in the last 15 minutes vs the hour's 15-minute average. */
  volumeSurge: number | null
  /** The last hour, `[unixSeconds, p]`, for a sparkline. Live games only. */
  points: Array<[number, number]>
  model: { side: string, fairValue: number, edge: number, confidence: number, signals: number, inPlay: boolean } | null
  flags: string[]
}

export interface ScannerEvent {
  eventTicker: string
  league: string
  /** 'in' | 'pre' | 'unknown' */
  state: string
  game: LiveGame | null
  outcomes: ScannerOutcome[]
  volume24h: number
  /** Largest absolute 15-minute move among the outcomes. */
  biggestMove: number
}

export interface ScannerPayload {
  asOf: string
  events: ScannerEvent[]
  modelAvailable: boolean
}

function seriesMarkets(series: string): Promise<KalshiMarketInfo[] & { raw?: unknown }> {
  return cached(`series:${series}`, CACHE_MS, async () => {
    const response = await fetch(`${BASE}/markets?series_ticker=${series}&status=open&limit=200`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok)
      throw new Error(`Kalshi series ${series} failed (${response.status})`)
    const data = await response.json() as { markets?: any[] }
    return (data.markets ?? []).map((raw) => {
      const info = toMarketInfo(raw) as KalshiMarketInfo & { volume24h?: number, previous?: number | null }
      info.volume24h = Number.parseFloat(String(raw?.volume_24h_fp ?? '0')) || 0
      const previous = Number.parseFloat(String(raw?.previous_price_dollars ?? ''))
      info.previous = Number.isFinite(previous) && previous > 0 ? previous : null
      return info
    })
  })
}

/** The model's view, game-aware, shared by every scanner request. */
function modelView(): Promise<Map<string, Candidate>> {
  return cached('scanner:model', 60_000, async () => {
    const db = new Database()
    try {
      const candidates = await buildCandidates(db, { venues: ['kalshi'], minEdge: 0.02, limit: 100, gameFor: liveGameForTicker })
      return new Map(candidates.map(candidate => [candidate.externalId, candidate]))
    }
    finally {
      db.close()
    }
  })
}

/** Eastern-time dates (YYYYMMDD) worth scanning: yesterday through tomorrow. */
function scanDates(now: Date): Set<string> {
  const out = new Set<string>()
  for (const offset of [-1, 0, 1]) {
    const at = new Date(now.getTime() + offset * 86_400_000)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    out.add(`${get('year')}${get('month')}${get('day')}`)
  }
  return out
}

/** Value of a probability series `minutes` before its last point. */
function changeOver(points: Array<[number, number]>, minutes: number): number | null {
  if (points.length < 2)
    return null
  const last = points[points.length - 1]!
  const cutoff = last[0] - minutes * 60
  let before: [number, number] | null = null
  for (const point of points) {
    if (point[0] <= cutoff)
      before = point
    else
      break
  }
  if (!before)
    return null
  return Math.round((last[1] - before[1]) * 1000) / 1000
}

/** Movement figures from an hour of minute candles. */
export function movementFrom(candles: KalshiCandle[]): { points: Array<[number, number]>, change5m: number | null, change15m: number | null, change60m: number | null, volumeSurge: number | null } {
  const points = candlesToPoints(candles)
  const last = candles.length > 0 ? candles[candles.length - 1]!.ts : 0
  const recent = candles.filter(candle => candle.ts > last - 15 * 60).reduce((sum, candle) => sum + candle.volume, 0)
  const hour = candles.filter(candle => candle.ts > last - 60 * 60).reduce((sum, candle) => sum + candle.volume, 0)
  const quarterAverage = hour / 4
  return {
    points,
    change5m: changeOver(points, 5),
    change15m: changeOver(points, 15),
    change60m: changeOver(points, 60),
    volumeSurge: quarterAverage > 0 ? Math.round((recent / quarterAverage) * 100) / 100 : null,
  }
}

export function flagsFor(outcome: Pick<ScannerOutcome, 'change15m' | 'volumeSurge' | 'spread'>): string[] {
  const flags: string[] = []
  if (outcome.change15m !== null && Math.abs(outcome.change15m) >= MOVE_FAST)
    flags.push(outcome.change15m > 0 ? 'Rising fast' : 'Falling fast')
  if (outcome.volumeSurge !== null && outcome.volumeSurge >= 2)
    flags.push('Volume surge')
  if (outcome.spread !== null && outcome.spread >= WIDE_SPREAD)
    flags.push('Wide spread')
  return flags
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await work(items[index]!)
    }
  }))
  return out
}

export async function scan(now = new Date()): Promise<ScannerPayload> {
  return cached('scanner:payload', 20_000, () => buildScan(now))
}

async function buildScan(now: Date): Promise<ScannerPayload> {
  const dates = scanDates(now)
  const listings = await Promise.all(SERIES.map(async ([league, series]) => ({
    league,
    markets: await seriesMarkets(series).catch(() => [] as KalshiMarketInfo[]),
  })))

  const byEvent = new Map<string, { league: string, markets: Array<KalshiMarketInfo & { volume24h?: number, previous?: number | null }> }>()
  for (const { league, markets } of listings) {
    for (const market of markets) {
      const ref = parseGameTicker(market.ticker)
      if (!ref || !dates.has(ref.date))
        continue
      const entry = byEvent.get(ref.eventTicker) ?? { league, markets: [] }
      entry.markets.push(market)
      byEvent.set(ref.eventTicker, entry)
    }
  }

  const model = await modelView().catch(() => new Map<string, Candidate>())
  const nowSeconds = Math.floor(now.getTime() / 1000)

  const events = await pooled([...byEvent.entries()], 6, async ([eventTicker, { league, markets }]): Promise<ScannerEvent | null> => {
    const game = await liveGameFor(markets[0]!.ticker, 'yes').catch(() => null)
    if (game?.state === 'post')
      return null
    const live = game?.state === 'in'

    const outcomes = await pooled(markets, 3, async (market): Promise<ScannerOutcome> => {
      const movement = live
        ? movementFrom(await kalshiCandles(eventTicker, market.ticker, nowSeconds - 70 * 60, nowSeconds, 1, CACHE_MS).catch(() => [] as KalshiCandle[]))
        : { points: [] as Array<[number, number]>, change5m: null, change15m: null, change60m: null, volumeSurge: null }
      const price = currentPrice(market)
      const spread = market.yesBid !== null && market.yesAsk !== null && market.yesAsk > 0 ? Math.round((market.yesAsk - market.yesBid) * 100) / 100 : null
      const candidate = model.get(market.ticker)
      const outcome: ScannerOutcome = {
        ticker: market.ticker,
        label: market.yesSubTitle || market.title,
        price,
        bid: market.yesBid,
        ask: market.yesAsk,
        spread,
        volume24h: Math.round(market.volume24h ?? 0),
        change5m: movement.change5m,
        change15m: movement.change15m,
        change60m: movement.change60m,
        change24h: market.previous && market.lastPrice !== null ? Math.round((market.lastPrice - market.previous) * 1000) / 1000 : null,
        volumeSurge: movement.volumeSurge,
        points: movement.points,
        model: candidate
          ? {
              side: candidate.side,
              fairValue: candidate.fairValue,
              edge: candidate.edge,
              confidence: candidate.confidence,
              signals: candidate.evidence.filter(item => item.contribution !== 0).length,
              inPlay: candidate.evidence.some(item => item.kind === 'in_play'),
            }
          : null,
        flags: [],
      }
      outcome.flags = flagsFor(outcome)
      return outcome
    })

    // A side that has not traded in the hour has no candles of its own, but
    // in a two-way game its price is the other side's complement.
    if (live && outcomes.length === 2) {
      const [a, b] = outcomes as [ScannerOutcome, ScannerOutcome]
      for (const [empty, full] of [[a, b], [b, a]] as const) {
        if (empty.points.length === 0 && full.points.length > 1) {
          const flip = (value: number | null) => value === null ? null : Math.round(-value * 1000) / 1000
          empty.points = full.points.map(([ts, p]) => [ts, Math.round((1 - p) * 1000) / 1000] as [number, number])
          empty.change5m = flip(full.change5m)
          empty.change15m = flip(full.change15m)
          empty.change60m = flip(full.change60m)
          empty.volumeSurge = full.volumeSurge
          empty.flags = flagsFor(empty)
        }
      }
    }

    outcomes.sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
    return {
      eventTicker,
      league,
      state: game?.state ?? 'unknown',
      game,
      outcomes,
      volume24h: outcomes.reduce((sum, outcome) => sum + outcome.volume24h, 0),
      biggestMove: Math.max(0, ...outcomes.map(outcome => Math.abs(outcome.change15m ?? 0))),
    }
  })

  const kept = events.filter((event): event is ScannerEvent => event !== null)
  kept.sort((a, b) => {
    if ((a.state === 'in') !== (b.state === 'in'))
      return a.state === 'in' ? -1 : 1
    if (a.state === 'in')
      return b.biggestMove - a.biggestMove || b.volume24h - a.volume24h
    return Date.parse(a.game?.startsAt ?? '') - Date.parse(b.game?.startsAt ?? '') || b.volume24h - a.volume24h
  })

  return { asOf: now.toISOString(), events: kept, modelAvailable: model.size > 0 }
}
