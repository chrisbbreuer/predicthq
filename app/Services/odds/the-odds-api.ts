import type { SportRow } from '../ingest/resolve'
import type { IngestRunTracker } from '../ingest/run'
import type { FeedBook, FeedEvent, FeedMarket, FeedOutcome, OddsProvider } from './provider'
import process from 'node:process'
import { norm, toIso } from '../../Support/keys'
import { fetchWithRetry } from '../ingest/run'

/**
 * The Odds API (the-odds-api.com) — the paid price feed.
 *
 * ### What changed and why
 * The previous implementation could not work. It matched incoming outcomes
 * to stored rows through a single global map of normalized selection
 * *labels*, so prices for one game could land on another, and full names
 * from the feed ("Los Angeles Lakers") never matched short stored labels
 * ("Lakers") at all. It also silently swallowed every error and returned
 * an empty list, so a feed matching nothing looked exactly like a quiet
 * market.
 *
 * This version does no matching of its own. It translates the feed into
 * the shared {@link FeedEvent} shape — carrying the provider's event id,
 * which is stable — and hands identity resolution to
 * `app/Services/ingest/resolve.ts`, which links once and joins on ids
 * thereafter. Failures are reported to the run tracker rather than
 * swallowed.
 *
 * ### Quota
 * Each region-and-market combination consumes one quota credit. When native
 * adapters exist we ask for those exact bookmakers, which The Odds API bills
 * as one region per ten books; that makes the backup carry the same books and
 * featured markets without paying for unrelated regional coverage. Requests
 * are also cached per league so a one-second native outage cannot spend paid
 * quota once a second.
 */

const BASE = 'https://api.the-odds-api.com/v4'

/** Bet types we request. Ordered by how much they are actually used. */
export const FEATURED_MARKETS = ['h2h', 'spreads', 'totals'] as const

/**
 * Regions to pull.
 *
 * More regions means more books and a better consensus, and — importantly
 * — costs nothing extra beyond the single per-request charge, because the
 * API bills per request rather than per book returned.
 */
const DEFAULT_REGIONS = 'us,uk,eu'
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 5 * 60 * 1000
const MIN_SAFE_REQUEST_INTERVAL_MS = 60 * 1000

interface CachedSport {
  attemptedAt: number
  events: FeedEvent[]
}

/** Shared by every provider instance in this process, including cron and API calls. */
const fallbackCache = new Map<string, CachedSport>()

export interface TheOddsApiOptions {
  /** Native bookmaker slugs to mirror for one league. Empty uses regional coverage. */
  bookmakersForSport?: (sportSlug: string) => string[]
  /** Paid-feed floor; native polling remains on its own faster cadence. */
  minRequestIntervalMs?: number
  now?: () => number
  request?: typeof fetchWithRetry
}

interface ApiOutcome {
  name?: string
  price?: number
  point?: number
  description?: string
  link?: string | null
  sid?: string | null
  bet_limit?: number
}

interface ApiMarket {
  key?: string
  last_update?: string
  outcomes?: ApiOutcome[]
  link?: string | null
  sid?: string | null
}

interface ApiBookmaker {
  key?: string
  title?: string
  last_update?: string
  markets?: ApiMarket[]
  link?: string | null
  sid?: string | null
}

interface ApiEvent {
  id?: string
  sport_key?: string
  commence_time?: string
  home_team?: string
  away_team?: string
  bookmakers?: ApiBookmaker[]
}

export class TheOddsApiProvider implements OddsProvider {
  readonly name = 'the-odds-api'

  constructor(
    private readonly apiKey: string,
    private readonly sports: SportRow[],
    private readonly options: TheOddsApiOptions = {},
  ) {}

  async fetchEvents(tracker: IngestRunTracker): Promise<FeedEvent[]> {
    const out: FeedEvent[] = []

    for (const sport of this.sports) {
      if (!sport.odds_api_key)
        continue

      const bookmakers = [...new Set(this.options.bookmakersForSport?.(sport.slug) ?? [])]
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
        .sort()
      const selector = bookmakers.length > 0
        ? `bookmakers=${encodeURIComponent(bookmakers.join(','))}`
        : `regions=${encodeURIComponent(process.env.ODDS_API_REGIONS?.trim() || DEFAULT_REGIONS)}`
      const cacheKey = `${sport.odds_api_key}:${selector}`
      const now = this.options.now?.() ?? Date.now()
      const cached = fallbackCache.get(cacheKey)
      const configuredMinimum = Number(process.env.ODDS_FALLBACK_MIN_INTERVAL_MS)
      const minimum = positiveMilliseconds(
        this.options.minRequestIntervalMs ?? configuredMinimum,
        DEFAULT_MIN_REQUEST_INTERVAL_MS,
      )

      if (cached && now - cached.attemptedAt < minimum) {
        out.push(...cached.events)
        continue
      }

      // Reserve the attempt before the request so two overlapping passes in
      // one process cannot both decide the fallback is due.
      fallbackCache.set(cacheKey, { attemptedAt: now, events: cached?.events ?? [] })

      const url = `${BASE}/sports/${sport.odds_api_key}/odds`
        + `?apiKey=${encodeURIComponent(this.apiKey)}`
        + `&${selector}`
        + `&markets=${FEATURED_MARKETS.join(',')}`
        + `&oddsFormat=decimal`
        + `&includeLinks=true&includeSids=true&includeBetLimits=true`

      tracker.requestCount++
      const res = await (this.options.request ?? fetchWithRetry)(url, { timeoutMs: 15_000 })

      if (!res) {
        tracker.fail(`${sport.slug}: network failure`)
        out.push(...(cached?.events ?? []))
        continue
      }

      // Read the budget before anything else — a 401 or 422 still carries
      // the headers, and knowing the quota is exhausted is the single most
      // useful fact when the board goes stale.
      tracker.readQuota(res.headers)

      if (!res.ok) {
        tracker.fail(`${sport.slug}: HTTP ${res.status}`)
        out.push(...(cached?.events ?? []))
        continue
      }

      let payload: ApiEvent[]
      try {
        payload = await res.json() as ApiEvent[]
      }
      catch {
        tracker.fail(`${sport.slug}: unparseable body`)
        out.push(...(cached?.events ?? []))
        continue
      }

      if (!Array.isArray(payload))
        continue

      const translatedEvents: FeedEvent[] = []
      for (const event of payload) {
        const translated = translateTheOddsApiEvent(event, sport.slug)
        if (translated)
          translatedEvents.push(translated)
      }

      fallbackCache.set(cacheKey, { attemptedAt: now, events: translatedEvents })
      out.push(...translatedEvents)
    }

    return out
  }
}

/** Translate one API event, or null when it is unusable. */
export function translateTheOddsApiEvent(event: ApiEvent, sportSlug: string): FeedEvent | null {
  const externalId = String(event.id ?? '')
  const homeTeam = String(event.home_team ?? '')
  const awayTeam = String(event.away_team ?? '')
  const commenceAt = toIso(event.commence_time)

  if (!externalId || !homeTeam || !awayTeam || !commenceAt)
    return null

  const books: FeedBook[] = []
  for (const book of event.bookmakers ?? []) {
    const key = String(book.key ?? '')
    if (!key)
      continue

    const markets: FeedMarket[] = []
    for (const market of book.markets ?? []) {
      const translatedMarket = translateMarket(market, homeTeam, awayTeam, String(book.link ?? ''))
      if (translatedMarket)
        markets.push(translatedMarket)
    }

    if (markets.length > 0) {
      books.push({
        key,
        title: String(book.title ?? key),
        lastUpdate: toIso(book.last_update),
        markets,
      })
    }
  }

  if (books.length === 0)
    return null

  return { externalId, sportSlug, commenceAt, homeTeam, awayTeam, books }
}

/**
 * Translate one bet type, mapping outcome names to our closed `side`
 * vocabulary.
 *
 * Team names are matched normalized because the feed is inconsistent about
 * punctuation and spacing between markets on the same event. An outcome
 * that matches neither team and is not a recognized keyword is dropped
 * rather than guessed at — a mis-sided price grades backwards, which is
 * worse than a missing one.
 */
function translateMarket(market: ApiMarket, homeTeam: string, awayTeam: string, eventLink: string): FeedMarket | null {
  const key = String(market.key ?? '')
  if (!FEATURED_MARKETS.includes(key as typeof FEATURED_MARKETS[number]))
    return null

  const home = norm(homeTeam)
  const away = norm(awayTeam)

  const outcomes: FeedOutcome[] = []
  let homePoint: number | null = null

  for (const outcome of market.outcomes ?? []) {
    const name = String(outcome.name ?? '')
    const price = Number(outcome.price)
    if (!name || !Number.isFinite(price) || price <= 1)
      continue

    const point = Number.isFinite(outcome.point as number) ? Number(outcome.point) : null
    const normalized = norm(name)

    let side: string | null = null
    if (key === 'totals') {
      if (normalized === 'over')
        side = 'over'
      else if (normalized === 'under')
        side = 'under'
    }
    else {
      if (normalized === home)
        side = 'home'
      else if (normalized === away)
        side = 'away'
      else if (normalized === 'draw' || normalized === 'tie')
        side = 'draw'
    }

    if (side === null)
      continue

    if (side === 'home')
      homePoint = point

    const limitAmount = Number(outcome.bet_limit)
    outcomes.push({
      side,
      label: name,
      point,
      price,
      link: String(outcome.link ?? market.link ?? eventLink) || undefined,
      sid: String(outcome.sid ?? '') || undefined,
      limitAmount: Number.isFinite(limitAmount) && limitAmount >= 0 ? limitAmount : undefined,
    })
  }

  if (outcomes.length === 0)
    return null

  // The market's line: the total for totals, the home handicap for
  // spreads, nothing for a moneyline. Deriving it from the home side keeps
  // one convention across every book, so two books on the same spread
  // resolve to the same market instead of a mirrored pair of them.
  let line: number | null = null
  if (key === 'totals')
    line = outcomes.find(o => o.side === 'over')?.point ?? outcomes[0]?.point ?? null
  else if (key === 'spreads')
    line = homePoint ?? (outcomes.find(o => o.side === 'away')?.point ?? null)

  return {
    marketType: key,
    line,
    period: 'full_game',
    outcomes,
  }
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= MIN_SAFE_REQUEST_INTERVAL_MS ? Number(value) : fallback
}

/** Test isolation for the process-scoped quota cache. */
export function clearTheOddsApiCache(): void {
  fallbackCache.clear()
}
