import type { KalshiCandle, KalshiMarketInfo } from './kalshi-public'
import { currentPrice, kalshiCandles, kalshiEventMarkets, kalshiMarket } from './kalshi-public'

/**
 * How a market's probability moved, as chart-ready series.
 *
 * Kalshi publishes one-minute, one-hour, and one-day candles. A range on
 * the page maps to the finest period that keeps the series a sensible
 * size, and the series is then thinned to at most `MAX_POINTS` so a week
 * of minute data never ships to a phone.
 *
 * Two-outcome events (a game's two teams) return both lines, the way the
 * venue draws them. Anything wider returns just the market asked about:
 * twelve lines on one small chart is a texture, not a chart.
 */

export type ChartRange = 'live' | '1d' | '1w' | '1m' | 'all'
export const CHART_RANGES: ChartRange[] = ['live', '1d', '1w', '1m', 'all']

export interface ChartOutcome {
  ticker: string
  label: string
  /** Latest probability, 0..1. */
  last: number | null
  /** `[unixSeconds, probability]`, oldest first. */
  points: Array<[number, number]>
}

export interface MarketChart {
  ticker: string
  eventTicker: string
  title: string
  range: ChartRange
  intervalMinutes: number
  start: number
  end: number
  outcomes: ChartOutcome[]
}

const MAX_POINTS = 360

export function parseRange(value: unknown): ChartRange {
  const text = String(value ?? '').toLowerCase()
  return (CHART_RANGES as string[]).includes(text) ? text as ChartRange : 'live'
}

/**
 * The window and candle period for a range.
 *
 * `live` starts shortly before the game when we know when it started, and
 * covers the last six hours otherwise. Nothing starts before the market
 * opened, since Kalshi returns empty candles for that span anyway.
 */
export function windowFor(
  range: ChartRange,
  nowSeconds: number,
  openedSeconds: number | null,
  liveSinceSeconds: number | null,
): { start: number, end: number, interval: 1 | 60 | 1440, ttlMs: number } {
  const hour = 3600
  const day = 24 * hour
  let start: number
  switch (range) {
    case '1d': start = nowSeconds - day; break
    case '1w': start = nowSeconds - 7 * day; break
    case '1m': start = nowSeconds - 30 * day; break
    case 'all': start = openedSeconds ?? nowSeconds - 90 * day; break
    default: start = liveSinceSeconds !== null && liveSinceSeconds < nowSeconds
      ? Math.max(liveSinceSeconds - 20 * 60, nowSeconds - 2 * day)
      : nowSeconds - 6 * hour
  }

  if (openedSeconds !== null && openedSeconds > start)
    start = openedSeconds
  if (start >= nowSeconds)
    start = nowSeconds - hour

  const span = nowSeconds - start
  const interval: 1 | 60 | 1440 = span <= 1.5 * day ? 1 : (span <= 60 * day ? 60 : 1440)
  const ttlMs = interval === 1 ? 15_000 : (interval === 60 ? 120_000 : 600_000)
  return { start: Math.floor(start), end: Math.ceil(nowSeconds), interval, ttlMs }
}

/**
 * Candles to a probability series.
 *
 * A period with a trade uses its close. A period without one uses the
 * quote midpoint when the quote is tight enough to mean something, and
 * otherwise carries the previous value forward, which is how the venue's
 * own chart reads: flat until something happens.
 */
export function candlesToPoints(candles: KalshiCandle[]): Array<[number, number]> {
  const points: Array<[number, number]> = []
  let previous: number | null = null
  for (const candle of candles) {
    let value: number | null = candle.close
    if (value === null && candle.bid !== null && candle.ask !== null && candle.ask > 0 && candle.ask - candle.bid <= 0.1)
      value = (candle.bid + candle.ask) / 2
    if (value === null)
      value = previous
    if (value === null)
      continue
    previous = value
    points.push([candle.ts, Math.round(value * 1000) / 1000])
  }
  return thin(points, MAX_POINTS)
}

/** Keep at most `max` points, always keeping the first and last. */
export function thin(points: Array<[number, number]>, max: number): Array<[number, number]> {
  if (points.length <= max)
    return points
  const step = (points.length - 1) / (max - 1)
  const out: Array<[number, number]> = []
  for (let i = 0; i < max; i++)
    out.push(points[Math.round(i * step)]!)
  return out
}

function seconds(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

/** The markets worth drawing beside `market`. */
function companions(market: KalshiMarketInfo, siblings: KalshiMarketInfo[]): KalshiMarketInfo[] {
  if (siblings.length === 2 && siblings.some(s => s.ticker === market.ticker))
    return [market, ...siblings.filter(s => s.ticker !== market.ticker)]
  return [market]
}

export interface ChartOptions {
  now?: Date
  /** When the underlying game started, to anchor the `live` range. */
  liveSince?: string | null
  /** Draw only the market asked about, never its siblings. */
  single?: boolean
}

export async function kalshiChart(ticker: string, range: ChartRange, options: ChartOptions = {}): Promise<MarketChart> {
  const market = await kalshiMarket(ticker)
  const siblings = options.single || market.legs.length > 0
    ? []
    : await kalshiEventMarkets(market.eventTicker).catch(() => [] as KalshiMarketInfo[])
  const drawn = companions(market, siblings)

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  const window = windowFor(range, nowSeconds, seconds(market.openTime), options.liveSince ? seconds(options.liveSince) : null)

  // Kalshi publishes no candles for parlays, so do not ask on every poll.
  const charted = market.legs.length === 0
  const outcomes = await Promise.all(drawn.map(async (entry): Promise<ChartOutcome> => {
    const candles = !charted ? [] : await kalshiCandles(entry.eventTicker || market.eventTicker, entry.ticker, window.start, window.end, window.interval, window.ttlMs)
      .catch(() => [] as KalshiCandle[])
    const points = candlesToPoints(candles)
    const last = currentPrice(entry)
    // End the line on the live quote so the chart and the headline number
    // agree, rather than stopping at the last closed minute.
    if (last !== null && points.length > 0 && points[points.length - 1]![0] < nowSeconds)
      points.push([nowSeconds, last])
    return {
      ticker: entry.ticker,
      label: entry.yesSubTitle || entry.title || entry.ticker,
      last,
      points,
    }
  }))

  return {
    ticker: market.ticker,
    eventTicker: market.eventTicker,
    title: market.title,
    range,
    intervalMinutes: window.interval,
    start: window.start,
    end: window.end,
    outcomes,
  }
}
