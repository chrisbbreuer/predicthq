import type { LiveGame } from '../../app/Services/trading/live-games'
import type { OddsPapiBoard } from '../../app/Services/trading/oddspapi-checkpoints'
import type { Database } from '../../app/Support/db'
import { expect, it } from 'bun:test'
import { matchOddsPapiQuotes, oddsPapiAllowance, saveOddsPapiQuotes } from '../../app/Services/trading/oddspapi-checkpoints'
import { schemaFor } from '../support/schema'

it('saves active offers with their receipt time and leaves the live trading board alone', async () => {
  const raw = schemaFor(':memory:', ['sports', 'sports_teams', 'market_events', 'markets', 'selections', 'bookmakers', 'odds', 'sportsbook_quote_observations'])
  const db = raw as unknown as Database
  const startsAt = '2026-11-20T01:00:00.000Z'
  const cutoff = Date.parse(startsAt) - 30 * 60_000
  const checkedAt = cutoff - 12_345
  const game = {
    league: 'nba', state: 'pre', startsAt,
    home: { name: 'Toronto Raptors', location: 'Toronto', abbreviation: 'TOR' },
    away: { name: 'Boston Celtics', location: 'Boston', abbreviation: 'BOS' },
  } as LiveGame
  const offer = (price: number) => ({ players: { 0: { active: true, price, changedAt: '2026-11-19T13:00:00.000Z' } } })
  const boards: OddsPapiBoard[] = ['pinnacle', 'draftkings'].map(book => ({
    book,
    checkedAt,
    fixtures: [{
      fixtureId: 'fixture', tournamentId: 132, statusName: 'Pre-Game', startTime: startsAt,
      participant1Name: 'Boston Celtics', participant2Name: 'Toronto Raptors',
      bookmakerOdds: { [book]: { bookmakerIsActive: true, suspended: false, markets: { 111: { marketActive: true, outcomes: { 111: offer(1.62), 112: offer(2.52) } } } } },
    }],
  }))
  try {
    raw.exec(`INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nba', 'NBA', 'Basketball')`)
    raw.run("INSERT INTO market_events (id, sport_id, title, commence_at) VALUES (1, 1, 'Boston at Toronto', ?)", [startsAt])
    raw.exec("INSERT INTO bookmakers (id,name,slug,kind) VALUES (1,'Pinnacle','pinnacle','sportsbook'),(2,'DraftKings','draftkings','sportsbook')")
    expect(matchOddsPapiQuotes(game, boards, checkedAt - 1)).toHaveLength(0)
    expect(matchOddsPapiQuotes(game, [{ ...boards[0]!, fixtures: [...boards[0]!.fixtures, ...boards[0]!.fixtures] }], cutoff)).toHaveLength(0)
    const quotes = matchOddsPapiQuotes(game, boards, cutoff)
    expect(quotes).toHaveLength(4)
    expect(quotes[0]).toMatchObject({ side: 'away', price: 1.62, updated_at: new Date(checkedAt).toISOString(), source: 'oddspapi' })
    expect(await saveOddsPapiQuotes(db, 1, game, quotes)).toBe(4)
    expect(await saveOddsPapiQuotes(db, 1, game, quotes)).toBe(0)
    expect(raw.query('SELECT COUNT(*) AS n FROM sportsBook_quote_observations WHERE checked_at_ms = ? AND source = ?').get(checkedAt, 'oddspapi')).toEqual({ n: 4 })
    expect(raw.query('SELECT COUNT(*) AS n FROM odds').get()).toEqual({ n: 0 })
  }
  finally {
    raw.close()
  }
})

it('spreads the quota across the remaining days and leaves a credit for archives', () => {
  const now = Date.parse('2026-11-19T06:00:00.000Z')
  expect(oddsPapiAllowance(now, 250, 15, 0)).toBe(20)
  expect(oddsPapiAllowance(now, 250, 19, 4)).toBe(16)
  expect(oddsPapiAllowance(now, 250, 249, 0)).toBe(0)
})
