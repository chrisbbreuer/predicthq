import { Database as Sqlite } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { Database } from '../../app/Support/db'
import { changesAfter, latestChangeId, sseFrame } from '../../app/Services/odds/stream'

/**
 * The live feed reads `odds_snapshots` after a cursor. These pin the
 * resumability (strictly after the id, oldest first), the filters, and the
 * wire format `EventSource` expects.
 */

function feedDb(): Database {
  const sqlite = new Sqlite(':memory:')
  sqlite.run('CREATE TABLE sports (id INTEGER PRIMARY KEY, slug TEXT)')
  sqlite.run('CREATE TABLE bookmakers (id INTEGER PRIMARY KEY, slug TEXT)')
  sqlite.run('CREATE TABLE market_events (id INTEGER PRIMARY KEY, sport_id INTEGER, title TEXT, commence_at TEXT)')
  sqlite.run('CREATE TABLE markets (id INTEGER PRIMARY KEY, market_event_id INTEGER, market_type TEXT, line REAL, period TEXT)')
  sqlite.run('CREATE TABLE selections (id INTEGER PRIMARY KEY, market_id INTEGER, side TEXT, label TEXT)')
  sqlite.run('CREATE TABLE odds_snapshots (id INTEGER PRIMARY KEY, selection_id INTEGER, bookmaker_id INTEGER, price REAL, implied_prob REAL, point REAL, captured_at TEXT, is_opening INTEGER)')
  sqlite.run(`INSERT INTO sports VALUES (1, 'nba'), (2, 'nhl')`)
  sqlite.run(`INSERT INTO bookmakers VALUES (1, 'kalshi'), (2, 'polymarket')`)
  sqlite.run(`INSERT INTO market_events VALUES (10, 1, 'New York Knicks at Toronto Raptors', '2026-11-18 00:30:00'), (11, 2, 'Wild at Sharks', '2026-11-18 03:00:00')`)
  sqlite.run(`INSERT INTO markets VALUES (20, 10, 'h2h', NULL, 'full_game'), (21, 11, 'h2h', NULL, 'full_game')`)
  sqlite.run(`INSERT INTO selections VALUES (30, 20, 'away', 'New York Knicks'), (31, 21, 'home', 'San Jose Sharks')`)
  sqlite.run(`INSERT INTO odds_snapshots VALUES
    (1, 30, 1, 1.6129, 0.62, NULL, '2026-11-17 21:00:00', 1),
    (2, 30, 2, 1.6667, 0.60, NULL, '2026-11-17 21:00:01', 1),
    (3, 31, 1, 2.7778, 0.36, NULL, '2026-11-17 21:00:02', 1),
    (4, 30, 1, 1.5873, 0.63, NULL, '2026-11-17 21:00:05', 0)`)
  return new Database({
    unsafe: (query: string, params: unknown[] = []) => ({
      execute: async () => sqlite.query(query).all(...(params as Array<string | number | null>)),
    }),
  })
}

describe('changesAfter', () => {
  it('returns changes strictly after the cursor, oldest first', async () => {
    const changes = await changesAfter(feedDb(), 1)
    expect(changes.map(change => change.id)).toEqual([2, 3, 4])
  })

  it('filters by sport, book and market type', async () => {
    const db = feedDb()
    expect((await changesAfter(db, 0, { sport: 'nhl' })).map(c => c.id)).toEqual([3])
    expect((await changesAfter(db, 0, { books: ['kalshi'] })).map(c => c.id)).toEqual([1, 3, 4])
    expect((await changesAfter(db, 0, { sport: 'nba', books: ['kalshi'], marketType: 'h2h' })).map(c => c.id)).toEqual([1, 4])
  })

  it('carries the game, market and side with each price', async () => {
    const [change] = await changesAfter(feedDb(), 3)
    expect(change!.book).toBe('kalshi')
    expect(change!.event.title).toBe('New York Knicks at Toronto Raptors')
    expect(change!.selection.side).toBe('away')
    expect(change!.price).toBeCloseTo(1.5873, 4)
    expect(change!.opening).toBe(false)
  })

  it('starts a cursorless stream from the newest change', async () => {
    expect(await latestChangeId(feedDb())).toBe(4)
  })
})

describe('sseFrame', () => {
  it('writes an id EventSource can resume from', async () => {
    const [change] = await changesAfter(feedDb(), 3)
    const frame = sseFrame(change!)
    expect(frame.startsWith('id: 4\nevent: price\ndata: {')).toBe(true)
    expect(frame.endsWith('\n\n')).toBe(true)
  })
})
