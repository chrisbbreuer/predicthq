import type { LiveGame } from '../../app/Services/trading/live-games'
import type { Database } from '../../app/Support/db'
import { describe, expect, it } from 'bun:test'
import { sportsbookConsensus } from '../../app/Services/trading/sportsbook-consensus'
import { schemaFor } from '../support/schema'

const start = '2026-11-18T01:00:00.000Z'
const quoteTime = Date.parse('2026-11-18T00:30:00.000Z')

function fixture() {
  const db = schemaFor(':memory:', ['sports', 'sports_teams', 'market_events', 'event_sources', 'markets', 'selections', 'bookmakers', 'odds_snapshots'])
  db.run("INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nba', 'NBA', 'Basketball')")
  db.run("INSERT INTO market_events (id, sport_id, title, commence_at) VALUES (1, 1, 'Away at Home', ?)", [start])
  db.run("INSERT INTO event_sources (market_event_id, provider, external_id) VALUES (1, 'espn', '401')")
  db.run("INSERT INTO markets (id, market_event_id, market_type, period) VALUES (1, 1, 'h2h', 'full_game')")
  db.run("INSERT INTO selections (id, market_id, label, side) VALUES (1, 1, 'Home', 'home'), (2, 1, 'Away', 'away')")
  for (const [id, slug, kind] of [[1, 'draftkings', 'sportsbook'], [2, 'pinnacle', 'sportsbook'], [3, 'kalshi', 'sportsbook'], [4, 'polymarket', 'prediction'], [5, 'circa', 'sportsbook'], [6, 'fanduel', 'sportsbook']] as const)
    db.run('INSERT INTO bookmakers (id, slug, name, kind) VALUES (?, ?, ?, ?)', [id, slug, slug, kind])
  const put = (book: number, side: number, price: number, minute: number) => db.run('INSERT INTO odds_snapshots (selection_id, bookmaker_id, price, captured_at) VALUES (?, ?, ?, ?)', [side, book, price, new Date(quoteTime + minute * 60_000).toISOString()])
  const game = { league: 'nba', gameId: '401', selected: 'home', startsAt: start } as LiveGame
  return { db, dbForApp: db as unknown as Database, game, put }
}

describe('sportsbook consensus', () => {
  it('uses only complete, fresh sportsbook markets known at the Kalshi quote time', async () => {
    const f = fixture()
    try {
      f.put(1, 1, 1.9, -2)
      f.put(1, 2, 1.9, -1)
      f.put(1, 1, 1.1, 1)
      f.put(2, 1, 1.5, -2)
      f.put(2, 2, 2.8, -3)
      for (const book of [3, 4]) {
        f.put(book, 1, 1.2, 0)
        f.put(book, 2, 5, 0)
      }
      f.put(5, 1, 1.9, -1)
      f.put(5, 2, 1.9, -16)
      f.put(6, 1, 1.9, -1)
      const result = await sportsbookConsensus(f.dbForApp, f.game, quoteTime)
      expect(result?.books).toEqual(['draftkings', 'pinnacle'])
      expect(result?.probability).toBeCloseTo((0.5 + 2.8 / 4.3) / 2, 10)
    }
    finally { f.db.close() }
  })

  it('does not pass off a lone sportsbook as a consensus', async () => {
    const f = fixture()
    try {
      f.put(1, 1, 1.9, 0)
      f.put(1, 2, 1.9, 0)
      f.put(3, 1, 1.9, 0)
      f.put(3, 2, 1.9, 0)
      expect(await sportsbookConsensus(f.dbForApp, f.game, quoteTime)).toBeNull()
    }
    finally { f.db.close() }
  })
})
