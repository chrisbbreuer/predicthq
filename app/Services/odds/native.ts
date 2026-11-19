import type { SportRow } from '../ingest/resolve'
import type { IngestRunTracker } from '../ingest/run'
import type { BookAdapter, BookContext } from './books/adapter'
import type { FeedEvent } from './provider'
import { norm } from '../../Support/keys'
import { adaptersForSport } from './books/adapter'

/**
 * Our own odds feed: every book we have an adapter for, read directly.
 *
 * ### Why the merge happens here
 *
 * Each adapter reports the same game under the book's own event id, so
 * fourteen adapters produce fourteen unrelated {@link FeedEvent}s for one
 * fixture. Something has to decide they are the same game, and it cannot
 * be the adapters — they never see each other's output.
 *
 * It also must not be left to `resolveEvent` downstream. That function
 * links a *provider's* record to one of our events, and it deliberately
 * refuses to merge two records from the same provider: a provider's own
 * ids are authoritative within that provider, so two different ids mean
 * two different games. Every book here arrives under the single provider
 * name `native`, so without merging first, the second book's quote on a
 * game would be refused the link and create a duplicate event instead —
 * one card per book on the board.
 *
 * So this class merges by the same rule `resolveEvent` uses for a *second*
 * provider: the same two teams kicking off within a few hours. That is the
 * strong constraint; the window only has to separate this fixture from the
 * next meeting of the same two clubs.
 *
 * ### Failure is per book, not per pass
 *
 * One book timing out is normal and must not cost the other thirteen.
 * Each adapter's failure is recorded against the run and the pass
 * continues, which is what makes the run status `partial` rather than
 * `failed` — and what stops an on-call alert firing on a transient blip.
 */

/**
 * How far apart two books' kickoff times may be and still be one game.
 *
 * Six hours, matching `resolveEvent`. Providers disagree by minutes,
 * occasionally by an hour when a broadcast slot moves, and teams play the
 * same opponent on consecutive days constantly — a baseball series is
 * three or four straight meetings of the identical pair. Six hours absorbs
 * every real discrepancy while staying far inside the ~18h gap between two
 * games of a series.
 */
const SAME_GAME_WINDOW_MS = 6 * 60 * 60 * 1000

/** Grouping key: one league, one unordered pair of teams. */
function pairKey(event: FeedEvent): string {
  const teams = [norm(event.homeTeam), norm(event.awayTeam)].sort()
  return `${event.sportSlug}:${teams.join('|')}`
}

/**
 * A stable id for a merged event.
 *
 * Must not change between passes, or `event_sources` accumulates a new
 * link every poll and the board grows a duplicate card per pass. Built
 * from the league, the unordered team pair, and the day — none of which
 * move — rather than from any one book's id, which would vanish the moment
 * that book stopped quoting.
 */
function mergedId(event: FeedEvent): string {
  const teams = [norm(event.homeTeam), norm(event.awayTeam)].sort()
  const day = event.commenceAt.slice(0, 10)
  return `${event.sportSlug}:${teams.join('-')}:${day}`
}

/**
 * Fold many books' views of the same fixtures into one event apiece.
 *
 * Exported for its own test: this is the function that decides whether the
 * board shows one card with fourteen prices or fourteen cards with one.
 */
export function mergeFeedEvents(events: FeedEvent[]): FeedEvent[] {
  const groups = new Map<string, FeedEvent[][]>()

  for (const event of events) {
    const start = new Date(event.commenceAt).getTime()
    if (!Number.isFinite(start))
      continue

    const key = pairKey(event)
    const clusters = groups.get(key) ?? []

    // Join the first cluster this event is close enough to. Clusters are
    // compared against their earliest member so a long chain of events
    // drifting an hour apiece cannot walk a cluster across a whole day.
    const cluster = clusters.find((members) => {
      const anchor = new Date(members[0]!.commenceAt).getTime()
      return Math.abs(anchor - start) <= SAME_GAME_WINDOW_MS
    })

    if (cluster)
      cluster.push(event)
    else
      clusters.push([event])

    groups.set(key, clusters)
  }

  const merged: FeedEvent[] = []

  for (const clusters of groups.values()) {
    for (const members of clusters) {
      // The first adapter to report wins the descriptive fields. Adapters
      // are run in configured order, which puts the sharp books first, so
      // this prefers the source we trust most on everything except price.
      const primary = members[0]!

      merged.push({
        externalId: mergedId(primary),
        sportSlug: primary.sportSlug,
        commenceAt: primary.commenceAt,
        homeTeam: primary.homeTeam,
        awayTeam: primary.awayTeam,
        books: members.flatMap(member => member.books),
      })
    }
  }

  return merged
}

export class NativeProvider {
  readonly name = 'native'

  constructor(
    private readonly adapters: BookAdapter[],
    private readonly sports: SportRow[],
    private readonly contextFor: (adapter: BookAdapter, tracker: IngestRunTracker) => BookContext,
  ) {}

  /** Leagues at least one enabled adapter covers. */
  coveredSports(): string[] {
    const covered = new Set<string>()
    for (const adapter of this.adapters) {
      for (const slug of adapter.sports)
        covered.add(slug)
    }
    return [...covered]
  }

  async fetchEvents(tracker: IngestRunTracker): Promise<FeedEvent[]> {
    const collected: FeedEvent[] = []

    for (const sport of this.sports) {
      const adapters = adaptersForSport(this.adapters, sport.slug)

      for (const adapter of adapters) {
        try {
          const events = await adapter.fetchSport(sport, this.contextFor(adapter, tracker))
          const checkedAt = new Date().toISOString()
          collected.push(...events.map(event => ({ ...event, books: event.books.map(book => ({ ...book, checkedAt })) })))
        }
        catch (error) {
          // One book's bad afternoon is not the pass's failure. Naming
          // both the book and the league is what makes the run row
          // actionable instead of merely alarming.
          const reason = error instanceof Error ? error.message : String(error)
          tracker.fail(`${adapter.slug}: ${sport.slug}: ${reason}`)
        }
      }
    }

    return mergeFeedEvents(collected)
  }
}
