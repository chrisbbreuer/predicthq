/**
 * Cadence bucketing and the book kill switch.
 *
 * The bucket decides how often a book is asked for a price, so getting it
 * wrong is expensive in one of two ways: a live game landing in the slow
 * bucket is a stale price the placement guard will reject, and a fixture
 * nine days out landing in the fast one is fourteen books polled every
 * second for a line that will not move today.
 *
 * The status-over-clock rule is the part worth pinning down. A feed that
 * lags on marking a game live must not be able to move it into the
 * slowest bucket at the exact moment it starts mattering most.
 */

import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { bucketFor, cadenceFor, enabledBooks, oddsConfig, proxyFor, sportEnabled } from '../../config/odds'

const NOW = Date.parse('2026-08-06T18:00:00.000Z')

function inHours(hours: number): string {
  return new Date(NOW + hours * 60 * 60 * 1000).toISOString()
}

afterEach(() => {
  delete process.env.ODDS_BOOKS_DISABLED
})

describe('bucketFor', () => {
  it('puts a game reported live in the fastest bucket', () => {
    // Started two hours ago and still running: the clock alone would say
    // this is long past, which is exactly the wrong answer.
    expect(bucketFor(inHours(-2), 'in_progress', NOW)).toBe('inPlay')
  })

  it('treats a started game as live even when the status feed lags', () => {
    expect(bucketFor(inHours(-0.5), 'scheduled', NOW)).toBe('inPlay')
  })

  it('buckets by proximity before kickoff', () => {
    expect(bucketFor(inHours(0.5), 'scheduled', NOW)).toBe('imminent')
    expect(bucketFor(inHours(6), 'scheduled', NOW)).toBe('near')
    expect(bucketFor(inHours(72), 'scheduled', NOW)).toBe('far')
  })

  it('stops polling an event that has finished', () => {
    expect(bucketFor(inHours(-3), 'final', NOW)).toBeNull()
    expect(bucketFor(inHours(-3), 'settled', NOW)).toBeNull()
    expect(bucketFor(inHours(-3), 'cancelled', NOW)).toBeNull()
  })

  it('declines an unparseable start time rather than guessing', () => {
    expect(bucketFor('not a date', 'scheduled', NOW)).toBeNull()
    expect(bucketFor('', 'scheduled', NOW)).toBeNull()
  })

  it('places the bucket edges on the near side', () => {
    // Exactly one hour out is still imminent, exactly a day out still near.
    expect(bucketFor(inHours(1), 'scheduled', NOW)).toBe('imminent')
    expect(bucketFor(inHours(24), 'scheduled', NOW)).toBe('near')
  })
})

describe('cadenceFor', () => {
  it('falls back to the defaults for a league with no override', () => {
    expect(cadenceFor('nfl')).toEqual(oddsConfig.cadence)
  })

  it('applies a partial override over the defaults', () => {
    const cadence = cadenceFor('politics')
    expect(cadence.inPlay).toBe(0)
    expect(cadence.far).toBe(0)
  })
})

describe('sportEnabled', () => {
  it('polls a league the catalogue carries a bookmaker line for', () => {
    expect(sportEnabled('nfl')).toBe(true)
    expect(sportEnabled('epl')).toBe(true)
  })

  it('skips prediction-only markets no bookmaker quotes', () => {
    // Politics, economics and crypto are priced by Kalshi and Polymarket
    // in a different loop. Asking a sportsbook for them is a guaranteed
    // empty response, so it is not asked.
    expect(sportEnabled('politics')).toBe(false)
    expect(sportEnabled('economics')).toBe(false)
    expect(sportEnabled('crypto')).toBe(false)
  })

  it('honours an explicit allow list', () => {
    const settings = { ...oddsConfig, sports: { ...oddsConfig.sports, only: ['nfl'] } }
    expect(sportEnabled('nfl', settings)).toBe(true)
    expect(sportEnabled('nba', settings)).toBe(false)
  })

  it('lets exclude beat only, so removing a league always works', () => {
    const settings = {
      ...oddsConfig,
      sports: { ...oddsConfig.sports, only: ['nfl', 'nba'], exclude: ['nba'] },
    }
    expect(sportEnabled('nfl', settings)).toBe(true)
    expect(sportEnabled('nba', settings)).toBe(false)
  })
})

describe('enabledBooks', () => {
  it('returns only the books with an adapter switched on', () => {
    const slugs = enabledBooks().map(b => b.slug)
    expect(slugs).toContain('draftkings')
    // Not yet written, so not yet claimed as coverage.
    expect(slugs).not.toContain('bet365')
    // On, because production runs in Germany and Pinnacle serves Germany.
    // From a jurisdiction it refuses, the fix is ODDS_PROXY_PINNACLE rather
    // than switching the book off.
    expect(slugs).toContain('pinnacle')
  })

  it('drops a book named in the env kill switch', () => {
    process.env.ODDS_BOOKS_DISABLED = 'draftkings'
    const slugs = enabledBooks().map(b => b.slug)
    expect(slugs).not.toContain('draftkings')
    expect(slugs).toContain('pinnacle')
  })

  it('tolerates whitespace and casing in the kill switch', () => {
    // Set under pressure, in a hurry, probably on a phone.
    process.env.ODDS_BOOKS_DISABLED = ' Pinnacle '
    const slugs = enabledBooks().map(b => b.slug)
    expect(slugs).not.toContain('pinnacle')
    // The books it did not name keep running.
    expect(slugs).toContain('draftkings')
  })

  it('every budgeted book names a real bookmaker slug', async () => {
    // A budget for a slug no `Bookmaker` row carries is a book whose
    // prices would be silently dropped at write time — the failure this
    // pairing is here to prevent.
    const model = (await import('../../app/Models/Bookmaker')).default as any
    const known = new Set<string>(
      (model?.traits?.useSeeder?.fixtures ?? []).map((f: { slug: string }) => f.slug),
    )

    // Books whose fixtures land with the adapters that need them.
    const pending = new Set(['espnbet', 'smarkets', 'matchbook', 'williamhill', 'unibet'])

    for (const book of oddsConfig.books) {
      if (pending.has(book.slug))
        continue
      expect(known.has(book.slug)).toBe(true)
    }
  })
})

describe('proxyFor', () => {
  it('is unset by default, so nothing is routed unexpectedly', () => {
    expect(proxyFor('pinnacle', {})).toBeUndefined()
  })

  it('reads a per-book route', () => {
    expect(proxyFor('pinnacle', { ODDS_PROXY_PINNACLE: 'http://de.example:8080' }))
      .toBe('http://de.example:8080')
  })

  it('falls back to the shared route', () => {
    expect(proxyFor('pinnacle', { ODDS_PROXY_URL: 'http://all.example:8080' }))
      .toBe('http://all.example:8080')
  })

  it('prefers the per-book route over the shared one', () => {
    // Routing every book through one country would change what the other
    // thirteen quote, so the specific reason wins over the blanket one.
    const proxy = proxyFor('pinnacle', {
      ODDS_PROXY_PINNACLE: 'http://de.example:8080',
      ODDS_PROXY_URL: 'http://all.example:8080',
    })
    expect(proxy).toBe('http://de.example:8080')
  })

  it('maps a hyphenated slug onto an env-safe name', () => {
    expect(proxyFor('efl-league-one', { ODDS_PROXY_EFL_LEAGUE_ONE: 'http://x:1' }))
      .toBe('http://x:1')
  })

  it('ignores an empty value rather than proxying to nowhere', () => {
    expect(proxyFor('pinnacle', { ODDS_PROXY_PINNACLE: '   ' })).toBeUndefined()
  })
})
