import process from 'node:process'

/**
 * **Odds Configuration**
 *
 * How often we ask each book for a price, and which books we ask.
 *
 * ### Why this is not another sports list
 *
 * The league catalogue has exactly one definition: the `useSeeder.fixtures`
 * on `app/Models/Sport.ts`, which `app/Services/ingest/sports-sync.ts`
 * reads rather than repeating. Holding the provider keys on the row is
 * what lets ingestion fan out from a single list instead of several
 * hardcoded arrays that drift apart, and a second catalogue here would
 * recreate exactly the drift that design avoids.
 *
 * So `sports` below is a **filter over that catalogue**, not a copy of it.
 * It names slugs; it never defines them. A league that is not in the model
 * cannot be enabled here, and a league turned off in the model stays off
 * whatever this file says.
 *
 * ### Why cadence is a bucket rather than a number
 *
 * A single interval has to be wrong in one of two directions: fast enough
 * for a game in progress means hammering fourteen books for a fixture that
 * is nine days away, and slow enough for the nine-day fixture means the
 * in-play price is stale before it is written. Both are real costs — the
 * first is request budget and the risk of being blocked, the second is the
 * staleness guard at placement rejecting orders.
 *
 * Bucketing by proximity resolves it. Almost every event on the board sits
 * in `far` and costs close to nothing, which is what buys the budget to
 * poll the handful of live games every second.
 *
 * ### Named export, deliberately
 *
 * Not a default export. A default import resolves to an empty module in
 * the stx server scope — silently, so the const is simply `undefined` and
 * every interpolation renders as literal `{{ }}`. `resources/views/pricing.stx`
 * documents that trap after hitting it. A named export is immune, and this
 * config is read from both stx pages and plain services.
 */

/** Poll intervals in milliseconds, one per proximity bucket. */
export interface OddsCadence {
  /** The game has started and has not finished. */
  inPlay: number
  /** Starts soon — the window where the line moves most. */
  imminent: number
  /** Starts today-ish. */
  near: number
  /** Everything else. The bulk of the board. */
  far: number
}

/** How an adapter reaches its book. */
export type BookTransport = 'json' | 'html' | 'browser' | 'websocket'

/** One book's budget and reach. */
export interface BookBudget {
  /** Matches `Bookmaker.slug`, so a budget cannot name a book we cannot store. */
  slug: string
  enabled: boolean
  transport: BookTransport
  /**
   * The ceiling this book's adapter may spend, enforced by a token bucket
   * it does not share. One adapter retrying hard must not be able to
   * starve the other thirteen, which a single global limiter would allow.
   */
  requestsPerSecond: number
  /** Jurisdictions this book quotes for, used to skip pointless calls. */
  regions: string[]
  /**
   * Send this book's requests out through a proxy.
   *
   * For books that are lawfully available only from certain countries.
   * Pinnacle answers a request from the United States with
   * `{"reason":"location"}` and a 403 — a licensing condition on who may
   * use the service, not an anti-bot check. The right answer to that is to
   * make the request from somewhere it is permitted, on a host we own
   * there, rather than to disguise where it came from.
   *
   * Production already runs in Germany, so nothing is needed there. This
   * exists so a developer working from a blocked country can route through
   * the same host instead of being unable to run the book at all.
   *
   * Read from the environment rather than written here: it is deployment
   * topology, and it differs per machine.
   */
  proxy?: string
}

export interface OddsSettings {
  /**
   * Source order. Native first, The Odds API as the gap filler — it is
   * asked only for what native returned nothing for, which is what takes
   * the paid request count to near zero without thinning the board.
   */
  providers: Array<'native' | 'the-odds-api'>
  sports: {
    /** Empty means every active league in the model. Slugs only. */
    only: string[]
    /** Removed after `only` is applied. */
    exclude: string[]
    /** Per-league cadence overrides, for leagues worth more or less than the default. */
    cadence: Record<string, Partial<OddsCadence>>
  }
  cadence: OddsCadence
  /** Upper edge of the `imminent` bucket, in ms before kickoff. */
  imminentWithinMs: number
  /** Upper edge of the `near` bucket, in ms before kickoff. */
  nearWithinMs: number
  books: BookBudget[]
}

/**
 * Books we have an adapter for, with the budget each is allowed.
 *
 * `requestsPerSecond` is set from what the book tolerates rather than from
 * what we would like. The sharp books are polled hardest because their
 * price is the one fair value is anchored to; a recreational book that
 * copies the market thirty seconds later carries less information per
 * request, so it gets fewer.
 */
const BOOKS: BookBudget[] = [
  // Sharp. Pinnacle is the single most valuable line on the board — low
  // margin, high limit, and it welcomes winning bettors, which is what
  // makes its price an estimate of probability rather than of where the
  // public money sits.
  // Pinnacle serves Germany and refuses the United States outright: the API
  // answers a US request with `{"reason":"location"}` and a 403. That is a
  // licensing condition on who may use the service, not an anti-bot check.
  //
  // Production runs in Germany, so this works there as an ordinary request
  // from a country Pinnacle serves. Working from a blocked country, set
  // `ODDS_PROXY_PINNACLE` to route through that same host rather than
  // disabling the book — the request is then made from where it is
  // permitted, which is a different thing from hiding where it came from.
  //
  // Worth the trouble: it is the sharpest public line, weighted 4x, it
  // covers NBA and NHL where DraftKings had nothing, and it publishes stake
  // limits that almost no book does.
  { slug: 'pinnacle', enabled: true, transport: 'json', requestsPerSecond: 4, regions: ['eu'] },
  // Planned sharp-book adapters. They stay declared for their budgets and
  // region metadata, but disabled until an adapter can actually serve them.
  { slug: 'circa', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['us'] },
  { slug: 'betonlineag', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['us'] },

  // US majors. Deep coverage of the four leagues plus college, and the
  // books our own users are most likely to hold an account with.
  { slug: 'draftkings', enabled: true, transport: 'json', requestsPerSecond: 3, regions: ['us'] },
  { slug: 'fanduel', enabled: false, transport: 'json', requestsPerSecond: 3, regions: ['us'] },
  { slug: 'betmgm', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['us'] },
  { slug: 'caesars', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['us'] },
  { slug: 'espnbet', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['us'] },

  // Exchanges. Back and lay both, plus traded volume — the closest thing
  // to a liquidity-weighted probability that is public.
  { slug: 'betfair', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['uk', 'eu'] },
  { slug: 'smarkets', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['uk', 'eu'] },
  { slug: 'matchbook', enabled: false, transport: 'json', requestsPerSecond: 1, regions: ['uk', 'eu'] },

  // UK/EU, for the ten soccer leagues in the catalogue. These are the most
  // likely to need a primed session or a real browser, hence the lower
  // budgets — a browser transport costs a page load, not a fetch.
  { slug: 'bet365', enabled: false, transport: 'browser', requestsPerSecond: 1, regions: ['uk', 'eu'] },
  { slug: 'williamhill', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['uk'] },
  { slug: 'unibet', enabled: false, transport: 'json', requestsPerSecond: 2, regions: ['uk', 'eu'] },
]

/**
 * Books switched off without a deploy.
 *
 * A book that starts returning malformed prices needs to be stopped in
 * minutes, and the `enabled` flags above take a release to change. This is
 * the same reasoning as the trading halt: the slow switch is the honest
 * default, and there is a fast one for when it matters.
 *
 * `ODDS_BOOKS_DISABLED=bet365,unibet`
 */
function disabledByEnv(): Set<string> {
  const raw = process.env.ODDS_BOOKS_DISABLED ?? ''
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
}

export const oddsConfig: OddsSettings = {
  providers: ['native', 'the-odds-api'],

  sports: {
    only: [],
    exclude: [],
    // Politics, economics and crypto have no bookmaker line at all — they
    // are prediction-venue markets, priced by Kalshi and Polymarket in a
    // different loop entirely. Polling books for them is a guaranteed
    // empty response, so they are cadenced out rather than requested.
    cadence: {
      politics: { far: 0, near: 0, imminent: 0, inPlay: 0 },
      economics: { far: 0, near: 0, imminent: 0, inPlay: 0 },
      crypto: { far: 0, near: 0, imminent: 0, inPlay: 0 },
    },
  },

  cadence: {
    inPlay: 1_000,
    imminent: 15_000,
    near: 60_000,
    far: 600_000,
  },

  imminentWithinMs: 60 * 60 * 1000,
  nearWithinMs: 24 * 60 * 60 * 1000,

  books: BOOKS,
}

/** The books actually pollable right now, after the env kill switch. */
export function enabledBooks(settings: OddsSettings = oddsConfig): BookBudget[] {
  const off = disabledByEnv()
  return settings.books
    .filter(book => book.enabled && !off.has(book.slug))
    .map(book => ({ ...book, proxy: proxyFor(book.slug) }))
}

/**
 * The egress route for one book, from the environment.
 *
 * `ODDS_PROXY_<SLUG>` for a single book, `ODDS_PROXY_URL` for all of them.
 * The per-book form wins, because the reason to proxy is usually specific
 * to one book's licensing rather than to the deployment as a whole —
 * routing every book through one country would change what the other
 * thirteen are quoted, which is the opposite of what is wanted.
 */
export function proxyFor(slug: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const key = `ODDS_PROXY_${slug.replace(/-/g, '_').toUpperCase()}`
  return env[key]?.trim() || env.ODDS_PROXY_URL?.trim() || undefined
}

/**
 * Resolve a league's cadence, overrides applied over the defaults.
 *
 * A bucket of `0` means "never poll this league at this proximity", which
 * is how a prediction-only market is excluded without pretending it has a
 * bookmaker line.
 */
export function cadenceFor(sportSlug: string, settings: OddsSettings = oddsConfig): OddsCadence {
  return { ...settings.cadence, ...(settings.sports.cadence[sportSlug] ?? {}) }
}

/** Whether this league should be polled for bookmaker prices at all. */
export function sportEnabled(sportSlug: string, settings: OddsSettings = oddsConfig): boolean {
  const { only, exclude } = settings.sports
  if (exclude.includes(sportSlug))
    return false
  if (only.length > 0 && !only.includes(sportSlug))
    return false

  // A league whose every bucket is zero is off, however it got that way.
  const cadence = cadenceFor(sportSlug, settings)
  return cadence.inPlay > 0 || cadence.imminent > 0 || cadence.near > 0 || cadence.far > 0
}

/**
 * Which bucket an event is in, from its start time and status.
 *
 * Status wins over the clock: a game that started an hour ago and is still
 * running is `inPlay`, not `far` on the wrong side of kickoff. Reading the
 * clock alone would move every live game into the slowest bucket the
 * moment it kicked off, which is precisely backwards.
 */
export function bucketFor(
  commenceAt: string,
  status: string,
  now: number = Date.now(),
  settings: OddsSettings = oddsConfig,
): keyof OddsCadence | null {
  if (status === 'final' || status === 'settled' || status === 'cancelled')
    return null

  const start = new Date(commenceAt).getTime()
  if (!Number.isFinite(start))
    return null

  if (status === 'in_progress' || status === 'live')
    return 'inPlay'

  const untilStart = start - now

  // Past its start time but not reported live yet. Treat as in-play: the
  // alternative is a game that has plainly begun sitting in the ten-minute
  // bucket because a status feed lagged.
  if (untilStart <= 0)
    return 'inPlay'

  if (untilStart <= settings.imminentWithinMs)
    return 'imminent'

  if (untilStart <= settings.nearWithinMs)
    return 'near'

  return 'far'
}
