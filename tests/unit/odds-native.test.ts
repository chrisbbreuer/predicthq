import type { SportRow } from '../../app/Services/ingest/resolve'
import type { IngestRunTracker } from '../../app/Services/ingest/run'
import type { BookAdapter } from '../../app/Services/odds/books/adapter'
import type { FeedEvent, OddsProvider } from '../../app/Services/odds/provider'
import { describe, expect, it } from 'bun:test'
import { CompositeProvider } from '../../app/Services/odds/composite'
import { mergeFeedEvents, NativeProvider } from '../../app/Services/odds/native'

/**
 * Aggregating many books into one board, and paying for as little of it as
 * possible.
 *
 * Two things are being pinned down. Fourteen adapters each report the same
 * game under the book's own id, and if those are not folded together the
 * board shows fourteen cards for one fixture — the single most visible way
 * this design can fail.
 *
 * And the paid feed must not be called for a league we already covered.
 * That is not an optimization; it is the entire economic argument for
 * building the adapters, so it is asserted on the request count rather
 * than on the returned data.
 */

function sport(slug: string): SportRow {
  return { id: 1, slug, title: slug.toUpperCase(), grouping: 'Test', espn_path: '', odds_api_key: slug, non_sporting: 0 }
}

/** A tracker that records rather than writes. */
function fakeTracker() {
  const errors: string[] = []
  return {
    tracker: { fail: (message: string) => void errors.push(message), requestCount: 0 } as unknown as IngestRunTracker,
    errors,
  }
}

function event(overrides: Partial<FeedEvent> & { bookKey: string }): FeedEvent {
  return {
    externalId: overrides.externalId ?? `${overrides.bookKey}-1`,
    sportSlug: overrides.sportSlug ?? 'nfl',
    commenceAt: overrides.commenceAt ?? '2026-09-10T00:20:00.000Z',
    homeTeam: overrides.homeTeam ?? 'Kansas City Chiefs',
    awayTeam: overrides.awayTeam ?? 'Baltimore Ravens',
    books: overrides.books ?? [{
      key: overrides.bookKey,
      title: overrides.bookKey,
      lastUpdate: '2026-09-09T23:00:00.000Z',
      markets: [{ marketType: 'h2h', line: null, outcomes: [{ side: 'home', label: 'KC', point: null, price: 1.8 }] }],
    }],
  }
}

function adapter(slug: string, events: FeedEvent[] | Error, sports = ['nfl']): BookAdapter {
  return {
    slug,
    kind: 'sportsbook',
    transport: 'json',
    sports,
    fetchSport: async () => {
      if (events instanceof Error)
        throw events
      return events
    },
  }
}

const context = () => ({ tracker: {} as IngestRunTracker, fetch: async () => null })

describe('mergeFeedEvents', () => {
  it('folds two books quoting one game into a single event', () => {
    const merged = mergeFeedEvents([
      event({ bookKey: 'pinnacle' }),
      event({ bookKey: 'draftkings' }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.books.map(b => b.key).sort()).toEqual(['draftkings', 'pinnacle'])
  })

  it('merges books that disagree about kickoff by under six hours', () => {
    // A broadcast slot moving is a real, common discrepancy.
    const merged = mergeFeedEvents([
      event({ bookKey: 'pinnacle', commenceAt: '2026-09-10T00:20:00.000Z' }),
      event({ bookKey: 'draftkings', commenceAt: '2026-09-10T01:15:00.000Z' }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.books).toHaveLength(2)
  })

  it('merges when books disagree about which side is home', () => {
    const merged = mergeFeedEvents([
      event({ bookKey: 'pinnacle', homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens' }),
      event({ bookKey: 'betfair', homeTeam: 'Baltimore Ravens', awayTeam: 'Kansas City Chiefs' }),
    ])

    expect(merged).toHaveLength(1)
  })

  it('keeps consecutive meetings of the same two teams apart', () => {
    // A baseball series is the same pair on back-to-back days. Collapsing
    // those would attribute one game's prices to another.
    const merged = mergeFeedEvents([
      event({ bookKey: 'pinnacle', sportSlug: 'mlb', commenceAt: '2026-07-01T23:10:00.000Z' }),
      event({ bookKey: 'pinnacle', sportSlug: 'mlb', commenceAt: '2026-07-02T23:10:00.000Z' }),
    ])

    expect(merged).toHaveLength(2)
  })

  it('keeps the same fixture in different leagues apart', () => {
    const merged = mergeFeedEvents([
      event({ bookKey: 'pinnacle', sportSlug: 'epl' }),
      event({ bookKey: 'pinnacle', sportSlug: 'efl-championship' }),
    ])

    expect(merged).toHaveLength(2)
  })

  it('gives a merged event the same id on every pass', () => {
    // A merged id that moved would add an event_sources link per poll and
    // grow a duplicate card each time.
    const first = mergeFeedEvents([event({ bookKey: 'pinnacle' })])[0]!
    const second = mergeFeedEvents([event({ bookKey: 'draftkings' })])[0]!

    expect(first.externalId).toBe(second.externalId)
    // And it is not any one book's id, which would vanish with that book.
    expect(first.externalId).not.toContain('pinnacle')
  })

  it('drops an event whose start time cannot be read', () => {
    expect(mergeFeedEvents([event({ bookKey: 'pinnacle', commenceAt: 'soon' })])).toHaveLength(0)
  })
})

describe('NativeProvider', () => {
  it('collects every adapter covering a league', async () => {
    const { tracker, errors } = fakeTracker()
    const provider = new NativeProvider(
      [adapter('pinnacle', [event({ bookKey: 'pinnacle' })]), adapter('draftkings', [event({ bookKey: 'draftkings' })])],
      [sport('nfl')],
      context,
    )

    const events = await provider.fetchEvents(tracker)

    expect(events).toHaveLength(1)
    expect(events[0]!.books).toHaveLength(2)
    expect(errors).toHaveLength(0)
  })

  it('records a failing book and keeps the others', async () => {
    const { tracker, errors } = fakeTracker()
    const provider = new NativeProvider(
      [adapter('pinnacle', new Error('timed out')), adapter('draftkings', [event({ bookKey: 'draftkings' })])],
      [sport('nfl')],
      context,
    )

    const events = await provider.fetchEvents(tracker)

    // The pass still produced a board — this is a `partial`, not a failure.
    expect(events).toHaveLength(1)
    expect(events[0]!.books.map(b => b.key)).toEqual(['draftkings'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('pinnacle')
    expect(errors[0]).toContain('nfl')
  })

  it('never asks a book about a league it does not cover', async () => {
    const { tracker } = fakeTracker()
    let asked = 0
    const ukOnly: BookAdapter = {
      ...adapter('bet365', [], ['epl']),
      fetchSport: async () => { asked++; return [] },
    }

    await new NativeProvider([ukOnly], [sport('nfl')], context).fetchEvents(tracker)

    expect(asked).toBe(0)
  })

  it('reports which leagues it can cover at all', () => {
    const provider = new NativeProvider(
      [adapter('pinnacle', [], ['nfl', 'nba']), adapter('bet365', [], ['epl'])],
      [],
      context,
    )

    expect(provider.coveredSports().sort()).toEqual(['epl', 'nba', 'nfl'])
  })
})

describe('CompositeProvider', () => {
  function countingProvider(name: string, events: FeedEvent[]): { provider: OddsProvider, calls: () => number } {
    let calls = 0
    return {
      provider: { name, fetchEvents: async () => { calls++; return events } },
      calls: () => calls,
    }
  }

  it('never calls the paid feed for a league we already covered', async () => {
    const { tracker } = fakeTracker()
    const native = countingProvider('native', [event({ bookKey: 'pinnacle' })])
    const paid = countingProvider('the-odds-api', [event({ bookKey: 'the-odds-api' })])

    const composite = new CompositeProvider(native.provider, [sport('nfl')], () => paid.provider)
    const events = await composite.fetchEvents(tracker)

    // The whole economic argument, asserted on the call rather than the data.
    expect(paid.calls()).toBe(0)
    expect(events).toHaveLength(1)
    expect(composite.fallbackSports()).toEqual([])
  })

  it('falls through for a league native produced nothing for', async () => {
    const { tracker } = fakeTracker()
    const native = countingProvider('native', [])
    const paid = countingProvider('the-odds-api', [event({ bookKey: 'the-odds-api' })])

    let askedAbout: string[] = []
    const composite = new CompositeProvider(native.provider, [sport('nfl')], (missing) => {
      askedAbout = missing.map(s => s.slug)
      return paid.provider
    })

    const events = await composite.fetchEvents(tracker)

    expect(paid.calls()).toBe(1)
    expect(askedAbout).toEqual(['nfl'])
    expect(events).toHaveLength(1)
    // Source switching must not change the provider id used downstream.
    expect(events[0]!.externalId).toBe(mergeFeedEvents([event({ bookKey: 'pinnacle' })])[0]!.externalId)
  })

  it('only pays for the leagues that are actually missing', async () => {
    const { tracker } = fakeTracker()
    const native = countingProvider('native', [event({ bookKey: 'pinnacle', sportSlug: 'nfl' })])

    let askedAbout: string[] = []
    const composite = new CompositeProvider(native.provider, [sport('nfl'), sport('epl')], (missing) => {
      askedAbout = missing.map(s => s.slug)
      return { name: 'the-odds-api', fetchEvents: async () => [] }
    })

    await composite.fetchEvents(tracker)

    expect(askedAbout).toEqual(['epl'])
  })

  it('discards a fallback event for a league native already covered', async () => {
    const { tracker } = fakeTracker()
    const native = countingProvider('native', [event({ bookKey: 'pinnacle', sportSlug: 'nfl' })])

    // A misconfigured fallback returning a covered league would otherwise
    // put two providers' prices on one game under two external ids.
    const composite = new CompositeProvider(native.provider, [sport('nfl'), sport('epl')], () => ({
      name: 'the-odds-api',
      fetchEvents: async () => [event({ bookKey: 'the-odds-api', sportSlug: 'nfl' })],
    }))

    const events = await composite.fetchEvents(tracker)

    expect(events).toHaveLength(1)
    expect(events[0]!.books.map(b => b.key)).toEqual(['pinnacle'])
  })

  it('keeps the native board when the fallback throws', async () => {
    const { tracker, errors } = fakeTracker()
    const native = countingProvider('native', [event({ bookKey: 'pinnacle', sportSlug: 'nfl' })])

    const composite = new CompositeProvider(native.provider, [sport('nfl'), sport('epl')], () => ({
      name: 'the-odds-api',
      fetchEvents: async () => { throw new Error('quota exhausted') },
    }))

    const events = await composite.fetchEvents(tracker)

    expect(events).toHaveLength(1)
    expect(errors[0]).toContain('quota exhausted')
  })

  it('copes with no fallback configured at all', async () => {
    const { tracker } = fakeTracker()
    const native = countingProvider('native', [])

    const composite = new CompositeProvider(native.provider, [sport('nfl')], () => null)

    expect(await composite.fetchEvents(tracker)).toEqual([])
  })
})
