import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { injuryReport, reportedInjury, saveInjuryReports } from '../../app/Services/fundamentals/injuries'
import { teamIntelligence } from '../../app/Services/scores/intelligence'
import type { Database } from '../../app/Support/db'
import { schemaFor } from '../support/schema'

const paths: string[] = []
function freshDb() {
  const path = `tests/temp/intelligence-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  return schemaFor(path, ['sports', 'sports_teams', 'team_injury_reports', 'market_events', 'event_results'])
}
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${path}${suffix}`, { force: true })
  }
})
const NOW = Date.parse('2026-11-18T17:00:00Z')
const injury = { status: 'Out', date: '2026-11-18T15:00Z', athlete: { displayName: 'Player A', id: '123', position: { abbreviation: 'C' } }, longComment: 'Resting.', details: { type: 'Knee', side: 'Left', returnDate: '2026-11-20' } }

describe('team intelligence', () => {
  it('preserves the full injury report and clears old absences with a new empty report', async () => {
    const raw = freshDb()
    const db = raw as unknown as Database
    const teams = [{ id: 1, espnId: '1' }]
    await saveInjuryReports(db, teams, [{ id: '1', injuries: [injury] }], new Date(NOW - 60_000).toISOString())
    const first = await injuryReport(db, 1, NOW)
    expect(first.known).toBe(true)
    expect(first.injuries[0]).toMatchObject({ athleteId: '123', position: 'C', status: 'Out', type: 'Knee', side: 'Left', comment: 'Resting.', returnDate: '2026-11-20', severity: 1 })
    await saveInjuryReports(db, teams, [], new Date(NOW).toISOString())
    expect((await injuryReport(db, 1, NOW)).injuries).toEqual([])
    expect(raw.query('SELECT COUNT(*) AS n FROM team_injury_reports').get()).toEqual({ n: 2 })
    raw.close()
  })

  it('marks missing or old reports unknown instead of claiming everyone is healthy', async () => {
    const raw = freshDb()
    const db = raw as unknown as Database
    expect((await injuryReport(db, 1, NOW)).known).toBe(false)
    await saveInjuryReports(db, [{ id: 1, espnId: '1' }], [], new Date(NOW - 7 * 3_600_000).toISOString())
    expect((await injuryReport(db, 1, NOW)).known).toBe(false)
    expect(reportedInjury({ athlete: {} })).toBeNull()
    raw.close()
  })

  it('calculates recent form, streak and venue changes without counting future or postponed games', async () => {
    const raw = freshDb()
    const db = raw as unknown as Database
    for (const [id, hours, venue, status, homeScore, awayScore] of [
      [1, -72, 'Arena A', 'final', 110, 100], [2, -24, 'Arena A', 'final', 115, 105],
      [3, -12, 'Arena C', 'postponed', 0, 0], [4, 0, 'Arena B', 'final', 1, 100],
    ] as const) {
      raw.run(`INSERT INTO market_events (id, sport_id, title, commence_at, venue, status, home_sports_team_id, away_sports_team_id) VALUES (?, 1, 'Game', ?, ?, ?, 1, 2)`, [id, new Date(NOW + hours * 3_600_000).toISOString(), venue, status])
      raw.run(`INSERT INTO event_results (market_event_id, home_score, away_score, winner_side, completed, source, settled_at, graded_at) VALUES (?, ?, ?, 'home', 1, 'espn', '', '')`, [id, homeScore, awayScore])
    }
    const result = await teamIntelligence(db, 1, new Date(NOW).toISOString(), 'Arena B', NOW)
    expect(result.form.map(row => row.result)).toEqual(['W', 'W'])
    expect(result.streak).toBe('W2')
    expect(result.backToBack).toBe(true)
    expect(result.restDays).toBe(1)
    expect(result.travel.venueChanged).toBe(true)
    expect(result.travel.previousVenue).toBe('Arena A')
    raw.close()
  })
})
