import type { FeedEvent } from '../../app/Services/odds/provider'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import { ingestOdds } from '../../app/Services/ingest/odds'
import { schemaFor } from '../support/schema'

/**
 * Streamed prices arrive one book at a time under a single "stream" run.
 * The event matcher never attaches two records from the same provider to
 * one event, so filing both books under that one name made the second book
 * to report a game create a duplicate of it. 304 duplicates appeared in
 * three minutes the first time Kalshi and Polymarket streamed together.
 */

const TABLES = [
  'sports', 'sports_teams', 'market_events', 'event_sources', 'markets', 'selections',
  'bookmakers', 'odds', 'odds_snapshots', 'book_market_coverage', 'ingest_runs',
]

const paths: string[] = []

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal'])
      rmSync(`${path}${suffix}`, { force: true })
  }
})

function freshDb() {
  const path = `tests/temp/stream-identity-${paths.length}-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  const db = schemaFor(path, TABLES)
  db.exec(`INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nba', 'NBA', 'Basketball')`)
  db.exec(`INSERT INTO bookmakers (id, name, slug, provider_key) VALUES (1, 'Kalshi', 'kalshi', 'kalshi'), (2, 'Polymarket', 'polymarket', 'polymarket')`)
  return db
}

function game(book: string, externalId: string, price: number): FeedEvent {
  return {
    externalId,
    sportSlug: 'nba',
    commenceAt: '2026-11-18T00:30:00.000Z',
    homeTeam: 'Toronto Raptors',
    awayTeam: 'New York Knicks',
    books: [{
      key: book,
      title: book,
      lastUpdate: '2026-11-17T21:00:00.000Z',
      markets: [{ marketType: 'h2h', line: null, outcomes: [
        { side: 'home', label: 'Toronto Raptors', point: null, price },
        { side: 'away', label: 'New York Knicks', point: null, price: 1.6 },
      ] }],
    }],
  }
}

describe('streamed books on one game', () => {
  it('land on the same event', async () => {
    const db = freshDb() as any
    await ingestOdds(db, { name: 'stream', fetchEvents: async () => [game('kalshi', 'KXNBAGAME-26NOV17NYKTOR', 2.6)] })
    await ingestOdds(db, { name: 'stream', fetchEvents: async () => [game('polymarket', '1284999', 2.55)] })

    const events = db.query('SELECT COUNT(*) AS n FROM market_events').get() as { n: number }
    expect(events.n).toBe(1)

    const books = db.query('SELECT COUNT(DISTINCT bookmaker_id) AS n FROM odds').get() as { n: number }
    expect(books.n).toBe(2)

    const links = db.query('SELECT provider FROM event_sources ORDER BY provider').all() as Array<{ provider: string }>
    expect(links.map(link => link.provider)).toEqual(['kalshi', 'polymarket'])
  })
})
