import type { ScheduledEvent, SportSchedule } from '../../app/Services/odds/engine'
import { describe, expect, it } from 'bun:test'
import { oddsConfig } from '../../config/odds'
import { dueSports, intervalForSport, OddsEngine } from '../../app/Services/odds/engine'

/**
 * How often each league gets asked for a price.
 *
 * This is where the request budget is actually spent, so both directions
 * of error are expensive. Too slow on a live game is a stale price the
 * placement guard rejects; too fast on a league whose next game is nine
 * days away is fourteen books polled for nothing, which is how an IP gets
 * blocked.
 *
 * The rule under test is that a league inherits the cadence of its *most
 * urgent* event, because a book publishes the whole league in one
 * response — so the marginal cost of keeping one live game fresh is zero
 * extra requests.
 */

const NOW = Date.parse('2026-08-06T18:00:00.000Z')

function at(hours: number): string {
  return new Date(NOW + hours * 60 * 60 * 1000).toISOString()
}

function event(sportSlug: string, hours: number, status = 'scheduled'): ScheduledEvent {
  return { sportSlug, commenceAt: at(hours), status }
}

describe('intervalForSport', () => {
  it('takes the cadence of the most urgent game in the league', () => {
    // One game in play, the rest days away. The league polls at in-play
    // speed, because the one request covers all of them anyway.
    const interval = intervalForSport('nfl', [
      event('nfl', 72),
      event('nfl', -1, 'in_progress'),
      event('nfl', 96),
    ], NOW)

    expect(interval).toBe(oddsConfig.cadence.inPlay)
  })

  it('drops back once nothing is live', () => {
    const interval = intervalForSport('nfl', [event('nfl', 72), event('nfl', 96)], NOW)
    expect(interval).toBe(oddsConfig.cadence.far)
  })

  it('uses the imminent bucket close to kickoff', () => {
    expect(intervalForSport('nfl', [event('nfl', 0.5)], NOW)).toBe(oddsConfig.cadence.imminent)
  })

  it('ignores events from other leagues', () => {
    // An NBA game in play must not speed up the NFL's polling.
    const interval = intervalForSport('nfl', [
      event('nfl', 72),
      event('nba', -1, 'in_progress'),
    ], NOW)

    expect(interval).toBe(oddsConfig.cadence.far)
  })

  it('returns zero when every game has finished', () => {
    const interval = intervalForSport('nfl', [
      event('nfl', -5, 'final'),
      event('nfl', -8, 'settled'),
    ], NOW)

    expect(interval).toBe(0)
  })

  it('returns zero for a league with no events at all', () => {
    expect(intervalForSport('nfl', [], NOW)).toBe(0)
  })

  it('never polls a prediction-only market', () => {
    // Politics has every bucket zeroed: no bookmaker quotes it, so asking
    // is a guaranteed empty response.
    const interval = intervalForSport('politics', [event('politics', 2)], NOW)
    expect(interval).toBe(0)
  })

  it('treats a zeroed bucket as skip, not as poll continuously', () => {
    // The dangerous misreading: 0 as an interval would be an unbounded
    // request loop against a book.
    const settings = {
      ...oddsConfig,
      sports: { ...oddsConfig.sports, cadence: { ...oddsConfig.sports.cadence, nfl: { inPlay: 0 } } },
    }

    const interval = intervalForSport('nfl', [event('nfl', -1, 'in_progress')], NOW, settings)
    expect(interval).toBe(0)
  })

  it('falls back to a slower live game when the fastest bucket is disabled', () => {
    const settings = {
      ...oddsConfig,
      sports: { ...oddsConfig.sports, cadence: { ...oddsConfig.sports.cadence, nfl: { inPlay: 0 } } },
    }

    const interval = intervalForSport('nfl', [
      event('nfl', -1, 'in_progress'),
      event('nfl', 0.5),
    ], NOW, settings)

    expect(interval).toBe(oddsConfig.cadence.imminent)
  })
})

describe('dueSports', () => {
  function schedule(slug: string, intervalMs: number, lastPolledAt: number): SportSchedule {
    return { slug, intervalMs, lastPolledAt }
  }

  it('returns only leagues whose interval has elapsed', () => {
    const due = dueSports([
      schedule('nfl', 1_000, NOW - 2_000),
      schedule('nba', 60_000, NOW - 1_000),
    ], NOW)

    expect(due.map(s => s.slug)).toEqual(['nfl'])
  })

  it('polls a league that has never been polled', () => {
    const due = dueSports([schedule('nfl', 600_000, 0)], NOW)
    expect(due.map(s => s.slug)).toEqual(['nfl'])
  })

  it('skips a league with no cadence', () => {
    // Zero interval means the league is off; elapsed time is irrelevant.
    expect(dueSports([schedule('politics', 0, 0)], NOW)).toEqual([])
  })

  it('puts the most overdue league first, measured in its own intervals', () => {
    // Three intervals late on a one-second cadence is more urgent than
    // two intervals late on a ten-minute one, even though the second has
    // waited far longer in wall-clock terms.
    const due = dueSports([
      schedule('nba', 600_000, NOW - 1_200_000),
      schedule('nfl', 1_000, NOW - 3_000),
    ], NOW)

    expect(due.map(s => s.slug)).toEqual(['nfl', 'nba'])
  })

  it('treats a league exactly at its interval as due', () => {
    const due = dueSports([schedule('nfl', 1_000, NOW - 1_000)], NOW)
    expect(due.map(s => s.slug)).toEqual(['nfl'])
  })
})

describe('fallback scheduling', () => {
  const sport = {
    id: 1,
    slug: 'nfl',
    title: 'NFL',
    grouping: 'Football',
    espn_path: 'football/nfl',
    odds_api_key: 'americanfootball_nfl',
    non_sporting: 0,
  }

  it('schedules a league with no native adapter when the paid backup exists', async () => {
    const engine = new OddsEngine({
      db: {} as any,
      adapters: [],
      sports: [sport],
      contextFor: () => ({}) as any,
      loadEvents: async () => [event('nfl', 2)],
      fallbackAvailable: true,
      now: () => NOW,
    })

    await engine.refreshSchedule()

    expect(engine.snapshot().map(schedule => schedule.slug)).toEqual(['nfl'])
  })

  it('does not schedule an unreachable league without any provider', async () => {
    const engine = new OddsEngine({
      db: {} as any,
      adapters: [],
      sports: [sport],
      contextFor: () => ({}) as any,
      loadEvents: async () => [event('nfl', 2)],
      fallbackAvailable: false,
      now: () => NOW,
    })

    await engine.refreshSchedule()

    expect(engine.snapshot()).toEqual([])
  })
})

describe('push subscriptions', () => {
  function adapter(slug: string, sports: string[], pushes = false) {
    return {
      slug,
      kind: 'sportsbook' as const,
      transport: 'json' as const,
      sports,
      fetchSport: async () => [],
      ...(pushes
        ? {
            subscribe: (_ctx: any, onChange: (e: any) => void) => {
              // Announce coverage the way a real socket would, on its
              // first message rather than on connect.
              for (const sport of sports)
                onChange({ sportSlug: sport, externalId: 'x', commenceAt: '', homeTeam: '', awayTeam: '', books: [] })
              return { close: () => {} }
            },
          }
        : {}),
    }
  }

  function engineWith(adapters: any[]) {
    return new OddsEngine({
      db: {} as any,
      adapters,
      sports: [{ slug: 'nfl' }, { slug: 'nba' }] as any,
      contextFor: () => ({}) as any,
      loadEvents: async () => [],
    })
  }

  it('does not consider a league pushed before any socket opens', () => {
    const engine = engineWith([adapter('pinnacle', ['nfl'], true)])
    expect(engine.fullyPushed('nfl')).toBe(false)
  })

  it('marks a league pushed once its only book is pushing', () => {
    const engine = engineWith([adapter('pinnacle', ['nfl'], true)])
    engine.startSubscriptions()
    expect(engine.fullyPushed('nfl')).toBe(true)
  })

  it('keeps polling a league where only one of two books pushes', () => {
    // The dangerous case: trusting the socket here would silently freeze
    // draftkings' prices, visible only as a book that stopped moving.
    const engine = engineWith([
      adapter('pinnacle', ['nfl'], true),
      adapter('draftkings', ['nfl'], false),
    ])
    engine.startSubscriptions()

    expect(engine.fullyPushed('nfl')).toBe(false)
  })

  it('treats a league no adapter covers as not pushed', () => {
    const engine = engineWith([adapter('pinnacle', ['nfl'], true)])
    engine.startSubscriptions()

    // Nothing covers nba, so it is not "fully pushed" by vacuous truth.
    expect(engine.fullyPushed('nba')).toBe(false)
  })

  it('puts a league back on the polling path when sockets close', () => {
    const engine = engineWith([adapter('pinnacle', ['nfl'], true)])
    engine.startSubscriptions()
    expect(engine.fullyPushed('nfl')).toBe(true)

    engine.stopSubscriptions()
    expect(engine.fullyPushed('nfl')).toBe(false)
  })

  it('survives an adapter whose socket refuses to open', () => {
    const broken = {
      slug: 'pinnacle',
      kind: 'sportsbook' as const,
      transport: 'websocket' as const,
      sports: ['nfl'],
      fetchSport: async () => [],
      subscribe: () => { throw new Error('handshake failed') },
    }

    const engine = engineWith([broken])
    expect(() => engine.startSubscriptions()).not.toThrow()

    // Falls back to polling rather than going dark.
    expect(engine.fullyPushed('nfl')).toBe(false)
  })

  it('does not open a second socket for the same book', () => {
    let opened = 0
    const counting = {
      slug: 'pinnacle',
      kind: 'sportsbook' as const,
      transport: 'websocket' as const,
      sports: ['nfl'],
      fetchSport: async () => [],
      subscribe: () => { opened++; return { close: () => {} } },
    }

    const engine = engineWith([counting])
    engine.startSubscriptions()
    engine.startSubscriptions()

    expect(opened).toBe(1)
  })
})
