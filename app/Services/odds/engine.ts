import type { OddsSettings } from '../../../config/odds'
import type { Database } from '../../Support/db'
import type { SportRow } from '../ingest/resolve'
import type { FeedEvent } from './provider'
import type { BookAdapter, BookContext, Subscription } from './books/adapter'
import { bucketFor, cadenceFor, oddsConfig, sportEnabled } from '../../../config/odds'
import { ingestOdds, nativeFirstOddsProvider } from '../ingest/odds'
import { adaptersForSport } from './books/adapter'

/**
 * The realtime price loop.
 *
 * ### Why this is not a scheduled job
 *
 * Prices used to ride `RunPipeline`, which runs every five minutes. Cron
 * cannot go below one minute, so no amount of tuning gets a scheduled job
 * to a cadence a live game needs — and the staleness guard at placement
 * rejects on exactly that. A long-running process is the only shape that
 * can poll something every second, so that is what this is.
 *
 * `RunPipeline` keeps fixtures, de-vig, settlement, and calibration. Only
 * the price fetch moved.
 *
 * ### Why the schedule is per league rather than per event
 *
 * A book publishes a whole league in one response. Polling per event would
 * mean one request per game where one request covers forty, so the useful
 * unit of scheduling is the league — and a league is polled at the rate its
 * *most urgent* event needs. A league with one game in play is polled every
 * second; the same league an hour later, with nothing live, drops back to
 * ten minutes.
 *
 * The waste in that is real but small: polling a whole league at in-play
 * speed to keep one game fresh costs the same single request either way.
 * The alternative — per-event requests — costs forty.
 */

/** One league's polling state. */
export interface SportSchedule {
  slug: string
  /** Milliseconds between polls, from the most urgent event in the league. */
  intervalMs: number
  /** Epoch ms of the last completed poll. 0 when never polled. */
  lastPolledAt: number
}

/** What the engine needs to know about an event to schedule its league. */
export interface ScheduledEvent {
  sportSlug: string
  commenceAt: string
  status: string
}

/**
 * How often a league should be polled, given its events.
 *
 * The fastest bucket any of its events falls into wins. Returns 0 when no
 * event in the league is worth polling at all — every game finished, or
 * the league is configured off — which the caller reads as "skip".
 */
export function intervalForSport(
  sportSlug: string,
  events: ScheduledEvent[],
  now: number = Date.now(),
  settings: OddsSettings = oddsConfig,
): number {
  if (!sportEnabled(sportSlug, settings))
    return 0

  const cadence = cadenceFor(sportSlug, settings)
  let fastest = 0

  for (const event of events) {
    if (event.sportSlug !== sportSlug)
      continue

    const bucket = bucketFor(event.commenceAt, event.status, now, settings)
    if (bucket === null)
      continue

    const interval = cadence[bucket]
    // A bucket set to zero means "never poll at this proximity", which is
    // how a prediction-only market is excluded. It must not be mistaken
    // for "poll continuously".
    if (interval <= 0)
      continue

    if (fastest === 0 || interval < fastest)
      fastest = interval
  }

  return fastest
}

/** Leagues whose next poll is due, most overdue first. */
export function dueSports(schedules: SportSchedule[], now: number = Date.now()): SportSchedule[] {
  return schedules
    .filter(schedule => schedule.intervalMs > 0 && now - schedule.lastPolledAt >= schedule.intervalMs)
    .sort((a, b) => (now - b.lastPolledAt) / b.intervalMs - (now - a.lastPolledAt) / a.intervalMs)
}

export interface EngineOptions {
  db: Database
  adapters: BookAdapter[]
  /** Builds the per-book request context, including its rate limiter. */
  contextFor: (adapter: BookAdapter, tracker: any) => BookContext
  /** All leagues the engine may consider. */
  sports: SportRow[]
  /** Reads the events that drive scheduling. Injected so it can be faked. */
  loadEvents: () => Promise<ScheduledEvent[]>
  /** Called after a pass that changed at least one price. */
  onChange?: (summary: { sports: string[], changed: number }) => void | Promise<void>
  /** Called for each pushed update from a book's socket. */
  onPush?: (bookSlug: string, event: FeedEvent) => void | Promise<void>
  /** Provenance for a subscription, which outlives any single pass. */
  trackerFor?: (adapter: BookAdapter) => any
  /** How often the loop wakes to check what is due. */
  tickMs?: number
  settings?: OddsSettings
  /** Overridable for tests; defaults to the real clock. */
  now?: () => number
  /** A configured paid fallback can schedule leagues no native adapter covers. */
  fallbackAvailable?: boolean
}

export interface PassResult {
  polled: string[]
  changed: number
  errors: string[]
}

export class OddsEngine {
  private readonly schedules = new Map<string, SportSchedule>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private stopped = false

  /** Live subscriptions, by book slug. */
  private readonly subscriptions = new Map<string, Subscription>()

  /**
   * Leagues currently covered by a push subscription, by book slug.
   *
   * A set per book rather than one shared set: two books can both push,
   * and a league is only safe to stop polling once *every* adapter that
   * covers it is pushing. Collapsing them would silence polling for a
   * league one book pushes and another does not, and the second book's
   * prices would simply stop updating — visible only as a book that has
   * quietly gone stale.
   */
  private readonly pushed = new Map<string, Set<string>>()

  constructor(private readonly options: EngineOptions) {}

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private get settings(): OddsSettings {
    return this.options.settings ?? oddsConfig
  }

  /**
   * A league is only safe to stop polling when every adapter covering it
   * is pushing. One book on a socket and another on polls means the second
   * book's prices stop updating the moment we trust the first.
   */
  fullyPushed(sportSlug: string): boolean {
    const covering = adaptersForSport(this.options.adapters, sportSlug)
    if (covering.length === 0)
      return false

    return covering.every(adapter => this.pushed.get(adapter.slug)?.has(sportSlug) === true)
  }

  /**
   * Open a socket for every adapter that offers one.
   *
   * A pushed update is applied immediately rather than being queued for
   * the next tick — the entire reason to hold a socket open is that the
   * change lands in milliseconds, and deferring it to a poll boundary
   * would spend the connection and keep the latency.
   */
  startSubscriptions(): void {
    for (const adapter of this.options.adapters) {
      if (!adapter.subscribe || this.subscriptions.has(adapter.slug))
        continue

      const tracker = this.options.trackerFor?.(adapter) ?? null
      const ctx = this.options.contextFor(adapter, tracker)

      try {
        const subscription = adapter.subscribe(ctx, (event) => {
          // Record coverage before applying, so a league is marked pushed
          // from the first message rather than after a full pass.
          const covered = this.pushed.get(adapter.slug) ?? new Set<string>()
          covered.add(event.sportSlug)
          this.pushed.set(adapter.slug, covered)

          void this.options.onPush?.(adapter.slug, event)
        })

        this.subscriptions.set(adapter.slug, subscription)
      }
      catch {
        // A socket that will not open is not fatal: the league stays on
        // the polling path, which is slower and still correct.
        this.pushed.delete(adapter.slug)
      }
    }
  }

  /** Close every socket. Called on shutdown. */
  stopSubscriptions(): void {
    for (const subscription of this.subscriptions.values())
      subscription.close()

    this.subscriptions.clear()
    this.pushed.clear()
  }

  /** Recompute every league's cadence from the current board. */
  async refreshSchedule(): Promise<SportSchedule[]> {
    const events = await this.options.loadEvents()
    const now = this.now

    for (const sport of this.options.sports) {
      // A league no adapter covers cannot be polled natively, whatever its
      // cadence says. Scheduling it anyway would burn a pass discovering
      // there is nothing to ask.
      if (adaptersForSport(this.options.adapters, sport.slug).length === 0 && !this.options.fallbackAvailable)
        continue

      const intervalMs = intervalForSport(sport.slug, events, now, this.settings)
      const existing = this.schedules.get(sport.slug)

      this.schedules.set(sport.slug, {
        slug: sport.slug,
        intervalMs,
        lastPolledAt: existing?.lastPolledAt ?? 0,
      })
    }

    return [...this.schedules.values()]
  }

  /**
   * Poll every league that is due, once.
   *
   * Returns rather than throws: a pass that fails is provenance, and the
   * loop must survive it. `ingestOdds` opens and closes its own run row,
   * so a crash here still leaves a `running` row behind as evidence.
   */
  async runOnce(): Promise<PassResult> {
    const now = this.now

    // A league every covering book is pushing does not need polling. This
    // is the whole payoff of holding a socket open, and it is filtered
    // here rather than in `dueSports` so the schedule stays a pure
    // function of the board — a book dropping its socket must put the
    // league straight back on the polling path with no state to unwind.
    const due = dueSports([...this.schedules.values()], now)
      .filter(schedule => !this.fullyPushed(schedule.slug))

    if (due.length === 0)
      return { polled: [], changed: 0, errors: [] }

    const slugs = new Set(due.map(schedule => schedule.slug))
    const sports = this.options.sports.filter(sport => slugs.has(sport.slug))

    // Mark polled *before* the request, not after. A league whose fetch
    // hangs must not become due again on the next tick and stack a second
    // in-flight request on top of the first.
    for (const schedule of due)
      schedule.lastPolledAt = now

    const provider = nativeFirstOddsProvider(sports, this.options.adapters, this.options.contextFor)

    try {
      const result = await ingestOdds(this.options.db, provider)

      if (result.pricesChanged > 0)
        await this.options.onChange?.({ sports: [...slugs], changed: result.pricesChanged })

      return { polled: [...slugs], changed: result.pricesChanged, errors: result.errors }
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { polled: [...slugs], changed: 0, errors: [reason] }
    }
  }

  /**
   * Run until stopped.
   *
   * The tick is deliberately much shorter than the fastest cadence: it is
   * only how often the engine *checks* what is due, so a one-second bucket
   * is not quantised up to two.
   */
  start(): void {
    if (this.timer || this.stopped)
      return

    const tickMs = this.options.tickMs ?? 250

    this.timer = setInterval(() => {
      // Never let a slow pass overlap itself. Books are rate limited per
      // book, and stacking passes would spend the whole budget on retries
      // of a request that is already in flight.
      if (this.running)
        return

      this.running = true
      void this.runOnce()
        .finally(() => { this.running = false })
    }, tickMs)
  }

  stop(): void {
    this.stopped = true
    this.stopSubscriptions()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Current schedule, for the status command and tests. */
  snapshot(): SportSchedule[] {
    return [...this.schedules.values()].map(schedule => ({ ...schedule }))
  }
}
