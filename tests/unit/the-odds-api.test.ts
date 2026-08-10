import type { SportRow } from '../../app/Services/ingest/resolve'
import type { IngestRunTracker } from '../../app/Services/ingest/run'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  clearTheOddsApiCache,
  TheOddsApiProvider,
  translateTheOddsApiEvent,
} from '../../app/Services/odds/the-odds-api'

const sport: SportRow = {
  id: 1,
  slug: 'nfl',
  title: 'NFL',
  grouping: 'Football',
  espn_path: 'football/nfl',
  odds_api_key: 'americanfootball_nfl',
  non_sporting: 0,
}

function tracker(): IngestRunTracker {
  return {
    requestCount: 0,
    readQuota: () => {},
    fail: () => {},
  } as unknown as IngestRunTracker
}

function payload() {
  return [{
    id: 'event-1',
    commence_time: '2026-09-10T00:20:00Z',
    home_team: 'Kansas City Chiefs',
    away_team: 'Baltimore Ravens',
    bookmakers: [{
      key: 'draftkings',
      title: 'DraftKings',
      last_update: '2026-09-09T23:59:00Z',
      link: 'https://book.example/event',
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Kansas City Chiefs', price: 1.8, sid: 'home', link: 'https://book.example/home', bet_limit: 20 },
            { name: 'Baltimore Ravens', price: 2.1, sid: 'away' },
          ],
        },
        {
          key: 'spreads',
          link: 'https://book.example/spread',
          outcomes: [
            { name: 'Kansas City Chiefs', price: 1.91, point: -3.5 },
            { name: 'Baltimore Ravens', price: 1.91, point: 3.5 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 1.9, point: 47.5 },
            { name: 'Under', price: 1.92, point: 47.5 },
          ],
        },
      ],
    }],
  }]
}

beforeEach(() => clearTheOddsApiCache())

describe('The Odds API translation', () => {
  it('preserves the same featured markets, lines, links, ids, and limits as native adapters', () => {
    const translated = translateTheOddsApiEvent(payload()[0]!, 'nfl')!

    expect(translated.books[0]!.markets.map(market => market.marketType)).toEqual(['h2h', 'spreads', 'totals'])
    expect(translated.books[0]!.markets[1]!.line).toBe(-3.5)
    expect(translated.books[0]!.markets[2]!.line).toBe(47.5)
    expect(translated.books[0]!.markets[0]!.outcomes[0]).toMatchObject({
      side: 'home',
      link: 'https://book.example/home',
      sid: 'home',
      limitAmount: 20,
    })
    expect(translated.books[0]!.markets[1]!.outcomes[0]!.link).toBe('https://book.example/spread')
  })

  it('drops an event that cannot be identified safely', () => {
    expect(translateTheOddsApiEvent({ ...payload()[0], home_team: '' }, 'nfl')).toBeNull()
  })
})

describe('The Odds API quota guard', () => {
  it('mirrors native bookmakers and does not request the same league twice inside the floor', async () => {
    const urls: string[] = []
    let now = 1_000
    const provider = new TheOddsApiProvider('secret', [sport], {
      bookmakersForSport: () => ['pinnacle', 'draftkings'],
      minRequestIntervalMs: 300_000,
      now: () => now,
      request: async (url) => {
        urls.push(url)
        return Response.json(payload(), { headers: { 'x-requests-remaining': '499' } })
      },
    })

    expect(await provider.fetchEvents(tracker())).toHaveLength(1)
    now += 1_000
    expect(await provider.fetchEvents(tracker())).toHaveLength(1)

    expect(urls).toHaveLength(1)
    const request = new URL(urls[0]!)
    expect(request.searchParams.get('bookmakers')).toBe('draftkings,pinnacle')
    expect(request.searchParams.get('regions')).toBeNull()
    expect(request.searchParams.get('markets')).toBe('h2h,spreads,totals')
    expect(request.searchParams.get('includeLinks')).toBe('true')
    expect(request.searchParams.get('includeSids')).toBe('true')
    expect(request.searchParams.get('includeBetLimits')).toBe('true')
  })
})
