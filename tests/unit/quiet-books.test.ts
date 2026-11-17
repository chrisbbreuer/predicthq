import { Database as Sqlite } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { Database } from '../../app/Support/db'
import { findQuietBooks } from '../../app/Services/watchdog'

/**
 * A streaming book that stops updating live games has to be noticed per
 * book: the shared stream run stays green while the other book pushes.
 */

function db(rows: Array<{ book: string, commence: string, updated: string }>): Database {
  const sqlite = new Sqlite(':memory:')
  sqlite.run('CREATE TABLE bookmakers (id INTEGER PRIMARY KEY, slug TEXT)')
  sqlite.run('CREATE TABLE market_events (id INTEGER PRIMARY KEY, commence_at TEXT)')
  sqlite.run('CREATE TABLE markets (id INTEGER PRIMARY KEY, market_event_id INTEGER)')
  sqlite.run('CREATE TABLE selections (id INTEGER PRIMARY KEY, market_id INTEGER)')
  sqlite.run('CREATE TABLE odds (id INTEGER PRIMARY KEY, selection_id INTEGER, bookmaker_id INTEGER, updated_at TEXT)')
  sqlite.run(`INSERT INTO bookmakers VALUES (1, 'kalshi'), (2, 'polymarket'), (3, 'draftkings')`)
  rows.forEach((row, index) => {
    const id = index + 1
    const book = { kalshi: 1, polymarket: 2, draftkings: 3 }[row.book]
    sqlite.run('INSERT INTO market_events VALUES (?, ?)', [id, row.commence])
    sqlite.run('INSERT INTO markets VALUES (?, ?)', [id, id])
    sqlite.run('INSERT INTO selections VALUES (?, ?)', [id, id])
    sqlite.run('INSERT INTO odds VALUES (?, ?, ?, ?)', [id, id, book!, row.updated])
  })
  return new Database({
    unsafe: (query: string, params: unknown[] = []) => ({
      execute: async () => sqlite.query(query).all(...(params as Array<string | number | null>)),
    }),
  })
}

const now = new Date('2026-11-18T01:00:00Z')

describe('findQuietBooks', () => {
  it('flags a book silent on a live game for more than fifteen minutes', async () => {
    const stalls = await findQuietBooks(db([
      { book: 'kalshi', commence: '2026-11-18 00:30:00', updated: '2026-11-18 00:40:00' },
      { book: 'polymarket', commence: '2026-11-18 00:30:00', updated: '2026-11-18 00:59:30' },
    ]), now)
    expect(stalls.map(stall => stall.provider)).toEqual(['kalshi'])
    expect(stalls[0]!.ageMinutes).toBe(20)
    expect(stalls[0]!.kind).toBe('stream')
  })

  it('does not judge a book with no live or imminent games', async () => {
    const stalls = await findQuietBooks(db([
      { book: 'kalshi', commence: '2026-11-20 00:30:00', updated: '2026-11-17 10:00:00' },
    ]), now)
    expect(stalls).toEqual([])
  })

  it('leaves polling books to the run-based check', async () => {
    const stalls = await findQuietBooks(db([
      { book: 'draftkings', commence: '2026-11-18 00:30:00', updated: '2026-11-17 10:00:00' },
    ]), now)
    expect(stalls).toEqual([])
  })
})
