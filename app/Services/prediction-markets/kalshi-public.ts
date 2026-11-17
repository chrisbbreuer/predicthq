/**
 * Kalshi's public market data, cached.
 *
 * Everything here is unauthenticated: market metadata, an event's sibling
 * markets, and price candles. None of it is private to a user, which is
 * why the portfolio and the bet page can both lean on it without passing
 * a credential anywhere near it.
 *
 * Every read goes through a small in-process TTL cache. The pages that use
 * this poll, and a polling page multiplied by open tabs is the fastest way
 * to get our IP rate limited at Kalshi. The cache is keyed by the exact
 * request, so two tabs on one game share one upstream call.
 */

const BASE = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'

export interface KalshiMarketInfo {
  ticker: string
  eventTicker: string
  title: string
  yesSubTitle: string
  noSubTitle: string
  status: string
  result: string
  openTime: string
  closeTime: string
  /** When the underlying event happens, for a game its scheduled start. */
  occursAt: string
  lastPrice: number | null
  yesBid: number | null
  yesAsk: number | null
  volume: number
  /** Parlay legs, for multivariate markets. Empty otherwise. */
  legs: Array<{ eventTicker: string, marketTicker: string, side: 'yes' | 'no' }>
}

export interface KalshiCandle {
  /** Period end, unix seconds. */
  ts: number
  /** Last trade in the period, when one happened. */
  close: number | null
  bid: number | null
  ask: number | null
  volume: number
}

interface Entry<T> {
  expiresAt: number
  value: Promise<T>
}

const cache = new Map<string, Entry<unknown>>()
const MAX_ENTRIES = 2_000
const FAILURE_TTL_MS = 20_000

/** Run `load` at most once per `ttlMs` for `key`; failures are not cached. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now)
    return hit.value

  if (cache.size >= MAX_ENTRIES) {
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now || cache.size >= MAX_ENTRIES)
        cache.delete(k)
      if (cache.size < MAX_ENTRIES * 0.8)
        break
    }
  }

  const value = load()
  cache.set(key, { expiresAt: now + ttlMs, value })
  // A failure is remembered briefly, not for the full TTL and not for
  // none of it: retrying a 404 or a 429 on every poll is how a page
  // talks Kalshi into rate limiting the whole host.
  value.catch(() => {
    const entry = cache.get(key)
    if (entry?.value === value)
      entry.expiresAt = Math.min(entry.expiresAt, Date.now() + FAILURE_TTL_MS)
  })
  return value
}

/** Test seam: forget everything cached. */
export function clearKalshiCache(): void {
  cache.clear()
}

export class KalshiPublicError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok)
    throw new KalshiPublicError(`Kalshi GET ${path.split('?')[0]} failed (${response.status})`, response.status)
  return await response.json() as T
}

function price(value: unknown): number | null {
  if (value === undefined || value === null || value === '')
    return null
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null
}

export function toMarketInfo(raw: any): KalshiMarketInfo {
  const legs = Array.isArray(raw?.mve_selected_legs) ? raw.mve_selected_legs : []
  return {
    ticker: String(raw?.ticker ?? ''),
    eventTicker: String(raw?.event_ticker ?? ''),
    title: String(raw?.title ?? ''),
    yesSubTitle: String(raw?.yes_sub_title ?? ''),
    noSubTitle: String(raw?.no_sub_title ?? ''),
    status: String(raw?.status ?? ''),
    result: String(raw?.result ?? ''),
    openTime: String(raw?.open_time ?? ''),
    closeTime: String(raw?.close_time ?? ''),
    occursAt: String(raw?.occurrence_datetime ?? raw?.expected_expiration_time ?? ''),
    lastPrice: price(raw?.last_price_dollars),
    yesBid: price(raw?.yes_bid_dollars),
    yesAsk: price(raw?.yes_ask_dollars),
    volume: Number.parseFloat(String(raw?.volume_fp ?? '0')) || 0,
    legs: legs.flatMap((leg: any) => leg?.market_ticker
      ? [{
          eventTicker: String(leg.event_ticker ?? ''),
          marketTicker: String(leg.market_ticker),
          side: String(leg.side ?? 'yes').toLowerCase() === 'no' ? 'no' as const : 'yes' as const,
        }]
      : []),
  }
}

/**
 * The best single number for "what the market thinks right now": the
 * midpoint of a two-sided quote when there is one, else the last trade.
 * A last trade from an hour ago on a live game is a stale answer; the
 * resting quote is what someone would actually pay.
 */
export function currentPrice(market: Pick<KalshiMarketInfo, 'lastPrice' | 'yesBid' | 'yesAsk' | 'status' | 'result'>): number | null {
  if (market.result === 'yes')
    return 1
  if (market.result === 'no')
    return 0
  const bid = market.yesBid
  const ask = market.yesAsk
  if (bid !== null && ask !== null && ask > 0 && ask >= bid && ask - bid <= 0.2)
    return Math.round(((bid + ask) / 2) * 1000) / 1000
  return market.lastPrice
}

/**
 * Multivariate (parlay) markets are invisible to the market listing
 * unless asked for by name: `/markets?tickers=` silently drops them
 * without `mve_filter=only`, and the single-market route can 404 for a
 * freshly minted one. Every lookup splits on this.
 */
export function isMultivariate(ticker: string): boolean {
  return /^KXMVE/i.test(ticker)
}

/** One market's metadata. */
export function kalshiMarket(ticker: string, ttlMs = 15_000): Promise<KalshiMarketInfo> {
  return cached(`market:${ticker}`, ttlMs, async () => {
    if (isMultivariate(ticker)) {
      const found = (await kalshiMarkets([ticker], ttlMs)).get(ticker)
      if (!found)
        throw new KalshiPublicError(`Kalshi has no market ${ticker}`, 404)
      return found
    }
    const data = await get<{ market: unknown }>(`/markets/${encodeURIComponent(ticker)}`)
    return toMarketInfo(data.market)
  })
}

/** Several markets by ticker, in batches the endpoint accepts. */
export async function kalshiMarkets(tickers: string[], ttlMs = 10_000): Promise<Map<string, KalshiMarketInfo>> {
  const unique = [...new Set(tickers.filter(Boolean))].sort()
  const out = new Map<string, KalshiMarketInfo>()
  const groups = [unique.filter(t => !isMultivariate(t)), unique.filter(isMultivariate)]
  for (const [index, group] of groups.entries()) {
    const filter = index === 1 ? '&mve_filter=only' : ''
    for (let i = 0; i < group.length; i += 40) {
      const batch = group.slice(i, i + 40)
      const markets = await cached(`markets:${batch.join(',')}`, ttlMs, async () => {
        const data = await get<{ markets?: unknown[] }>(`/markets?limit=${batch.length}${filter}&tickers=${batch.map(encodeURIComponent).join(',')}`)
        return (data.markets ?? []).map(toMarketInfo)
      })
      for (const market of markets)
        out.set(market.ticker, market)
    }
  }
  return out
}

/** Every market listed under one event. */
export function kalshiEventMarkets(eventTicker: string, ttlMs = 15_000): Promise<KalshiMarketInfo[]> {
  return cached(`event:${eventTicker}`, ttlMs, async () => {
    const data = await get<{ markets?: unknown[] }>(`/markets?limit=100&event_ticker=${encodeURIComponent(eventTicker)}`)
    return (data.markets ?? []).map(toMarketInfo)
  })
}

/** The series an event belongs to. Kalshi event tickers lead with it. */
export function seriesOf(eventTicker: string): string {
  return eventTicker.split('-')[0] ?? eventTicker
}

/**
 * Price candles for one market.
 *
 * `intervalMinutes` is one of Kalshi's three periods. A period with no
 * trade carries no close; the caller decides whether to fill it from the
 * quote or carry the previous value forward.
 */
export function kalshiCandles(
  eventTicker: string,
  ticker: string,
  startTs: number,
  endTs: number,
  intervalMinutes: 1 | 60 | 1440,
  ttlMs: number,
): Promise<KalshiCandle[]> {
  // Bucket the window so a page polling every few seconds reuses one read
  // instead of asking for a fresh window each time.
  const bucket = Math.max(15, Math.round(ttlMs / 1000))
  const end = Math.ceil(endTs / bucket) * bucket
  const key = `candles:${ticker}:${startTs}:${end}:${intervalMinutes}`
  return cached(key, ttlMs, async () => {
    const series = seriesOf(eventTicker)
    const data = await get<{ candlesticks?: any[] }>(
      `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${end}&period_interval=${intervalMinutes}`,
    )
    return (data.candlesticks ?? []).map((candle: any) => ({
      ts: Number(candle?.end_period_ts) || 0,
      close: price(candle?.price?.close_dollars),
      bid: price(candle?.yes_bid?.close_dollars),
      ask: price(candle?.yes_ask?.close_dollars),
      volume: Number.parseFloat(String(candle?.volume_fp ?? '0')) || 0,
    })).filter(candle => candle.ts > 0)
  })
}
