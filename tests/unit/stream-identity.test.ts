import type { FeedEvent } from '../../app/Services/odds/provider'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import { ingestOdds } from '../../app/Services/ingest/odds'
import { mergeFeedEvents } from '../../app/Services/odds/native'
import { writePushed } from '../../app/Services/odds/push-buffer'
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

  it('match a game stored in ESPN\'s short time format', async () => {
    const db = freshDb() as any
    // ESPN's schedule stores `2026-11-18T00:30Z`; the database layer turns
    // a full ISO time into `2026-11-18 00:30:00`. A string comparison
    // between the two never matched on the same date.
    await ingestOdds(db, { name: 'stream', fetchEvents: async () => [{ ...game('kalshi', 'KXNBAGAME-26NOV17NYKTOR', 2.6), commenceAt: '2026-11-18T00:30Z' }] })
    await ingestOdds(db, { name: 'stream', fetchEvents: async () => [game('polymarket', '1284999', 2.55)] })

    const events = db.query('SELECT COUNT(*) AS n FROM market_events').get() as { n: number }
    expect(events.n).toBe(1)
  })
})

describe('a game seen by polling, then by the stream', () => {
  it('stays one event', async () => {
    const db = freshDb() as any
    // Polling merges first, which gives a single-book game a canonical id.
    await ingestOdds(db, { name: 'composite', fetchEvents: async () => mergeFeedEvents([game('kalshi', 'KXNBAGAME-26NOV17NYKTOR', 2.6)]) })
    // The stream pushes the venue's raw ticker.
    await writePushed(db, [game('kalshi', 'KXNBAGAME-26NOV17NYKTOR', 2.5)])

    const events = db.query('SELECT COUNT(*) AS n FROM market_events').get() as { n: number }
    expect(events.n).toBe(1)
  })
})

describe('bookmaker quote freshness', () => {
  it('refreshes unchanged quotes only when the provider checks them again', async () => {
    const db = freshDb() as any
    db.exec("INSERT INTO bookmakers (id, name, slug, provider_key) VALUES (3, 'DraftKings', 'draftkings', 'draftkings')")
    const event = game('draftkings', 'book-game', 2.6)
    const ingest = (cached: boolean) => ingestOdds(db, {
      name: 'composite',
      fetchEvents: async () => [{ ...event, books: [{ ...event.books[0]!, fromCache: cached }] }],
    })
    const lastChecked = () => db.query('SELECT updated_at FROM odds WHERE bookmaker_id = 3 LIMIT 1').get().updated_at

    await ingest(false)
    db.exec("UPDATE odds SET updated_at = '2026-11-17T21:00:00.000Z' WHERE bookmaker_id = 3")
    expect((await ingest(true)).pricesWritten).toBe(0)
    expect(lastChecked()).toBe(event.books[0]!.lastUpdate)

    const checked = await ingest(false)
    expect(checked.pricesWritten).toBe(2)
    expect(checked.snapshots).toBe(0)
    expect(lastChecked()).not.toBe(event.books[0]!.lastUpdate)
  })
})

describe('resolveEvent through the database layer', () => {
  it('matches an ESPN-format start time against a full ISO one', async () => {
    const { Database } = await import('../../app/Support/db')
    const { resolveEvent } = await import('../../app/Services/ingest/resolve')
    const raw = freshDb()
    raw.exec(`INSERT INTO market_events (id, sport_id, title, commence_at, status, home_sports_team_id, away_sports_team_id) VALUES (7, 1, 'New York Knicks at Toronto Raptors', '2026-11-18T00:30Z', 'scheduled', 1, 2)`)
    // The real layer rewrites ISO parameters to `YYYY-MM-DD HH:MM:SS`, which
    // is what production binds and what a string BETWEEN got wrong.
    const db = new Database({
      unsafe: (query: string, params: unknown[] = []) => ({
        execute: async () => /^\s*(insert|update|delete)/i.test(query)
          ? raw.query(query).run(...(params as Array<string | number | null>))
          : raw.query(query).all(...(params as Array<string | number | null>)),
      }),
      updateOrInsert: async (table: string, match: Record<string, unknown>, values: Record<string, unknown>) => {
        const where = Object.keys(match).map(key => `${key} = ?`).join(' AND ')
        const found = raw.query(`SELECT 1 FROM ${table} WHERE ${where}`).get(...(Object.values(match) as Array<string | number | null>))
        const row = { ...match, ...values }
        if (found) {
          raw.query(`UPDATE ${table} SET ${Object.keys(values).map(key => `${key} = ?`).join(', ')} WHERE ${where}`)
            .run(...([...Object.values(values), ...Object.values(match)] as Array<string | number | null>))
        }
        else {
          raw.query(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
            .run(...(Object.values(row) as Array<string | number | null>))
        }
      },
    })
    const { eventId, created } = await resolveEvent(db, {
      sportId: 1,
      provider: 'kalshi',
      externalId: 'KXNBAGAME-26NOV17NYKTOR',
      title: 'New York Knicks at Toronto Raptors',
      commenceAt: '2026-11-18T00:30:00.000Z',
      homeTeamId: 1,
      awayTeamId: 2,
    })
    expect(created).toBe(false)
    expect(eventId).toBe(7)
  })
})
