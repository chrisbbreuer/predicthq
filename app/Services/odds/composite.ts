import type { SportRow } from '../ingest/resolve'
import type { IngestRunTracker } from '../ingest/run'
import type { FeedEvent, OddsProvider } from './provider'
import { mergeFeedEvents } from './native'

/**
 * Our own feed first, a paid one only for what it missed.
 *
 * ### Why the gap is measured per league, not per event
 *
 * Filling gaps per event would be more precise and would defeat the
 * purpose. The paid feed bills per request per league; asking it which
 * events it has, in order to discover we already had them, spends exactly
 * the quota this whole exercise exists to stop spending. The question that
 * saves money is "should we call this league at all", and that can only be
 * answered before the call.
 *
 * So: any league the native feed produced at least one event for is
 * considered covered, and the paid provider is never asked about it. A
 * league it produced nothing for is a real gap — no adapter covers it, or
 * every adapter covering it failed — and that is worth paying for.
 *
 * ### Why a factory rather than a provider
 *
 * The fallback has to be built knowing which leagues to ask about, since
 * that is what bounds the bill. Handing in a ready-made provider would
 * mean it had already decided to fetch everything.
 */
export class CompositeProvider implements OddsProvider {
  readonly name = 'composite'

  /** Leagues the fallback was asked about on the last pass. */
  private lastFallbackSports: string[] = []

  constructor(
    private readonly primary: OddsProvider,
    private readonly sports: SportRow[],
    /** Returns a provider scoped to `missing`, or null when none is configured. */
    private readonly fallbackFor: (missing: SportRow[]) => OddsProvider | null,
  ) {}

  /** Which leagues fell through last pass. Read by the run summary. */
  fallbackSports(): string[] {
    return [...this.lastFallbackSports]
  }

  async fetchEvents(tracker: IngestRunTracker): Promise<FeedEvent[]> {
    const events = await this.primary.fetchEvents(tracker)

    const covered = new Set(events.map(event => event.sportSlug))
    const missing = this.sports.filter(sport => !covered.has(sport.slug))
    this.lastFallbackSports = missing.map(sport => sport.slug)

    if (missing.length === 0)
      return events

    const fallback = this.fallbackFor(missing)
    if (!fallback)
      return events

    try {
      const filled = await fallback.fetchEvents(tracker)

      // Guard the invariant rather than trusting it. A fallback scoped to
      // the missing leagues should not return a covered one, but if it
      // does, letting it through would put two providers' prices on one
      // game under two different external ids — a duplicate card, which is
      // the exact failure the composite exists to avoid.
      // Canonicalize both sources to the native team/day id. Without this,
      // a league that fell back on one pass and recovered natively on the
      // next would present two provider ids for the same fixture and create
      // a duplicate card.
      return mergeFeedEvents([...events, ...filled.filter(event => !covered.has(event.sportSlug))])
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      tracker.fail(`fallback ${fallback.name}: ${reason}`)
      return events
    }
  }
}
