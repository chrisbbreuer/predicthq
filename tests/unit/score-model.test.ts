import type { Fixture, PlayedGame } from '../../app/Services/scores/score-model'
import type { Database } from '../../app/Support/db'
import { expect, it } from 'bun:test'
import { captureScoreForecasts, recordedScoreForecast } from '../../app/Services/scores/score-forecast'
import { replayScores } from '../../app/Services/scores/score-model'
import { schemaFor } from '../support/schema'

it('forecasts using only finals and injury snapshots visible at the pregame cutoff', () => {
  const day = 86_400_000
  const fixture: Fixture = { id: 100, starts: 100 * day, home: 1, away: 2 }
  const history: PlayedGame[] = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, starts: (65 + i) * day, knownAt: (65 + i) * day + 2 * 3_600_000,
    home: i % 2 + 1, away: 2 - i % 2, final: i % 2 ? [103, 114] : [116, 101],
  }))
  const afterCutoff = fixture.starts - 15 * 60_000
  const delayed: PlayedGame = { id: 99, starts: fixture.starts - day, knownAt: afterCutoff, home: 1, away: 2, final: [301, 1] }
  const expected = replayScores('nba', history, new Map(), [fixture]).fixtures.get(fixture.id)
  expect(expected?.scores.opponentAdjusted?.[0]).toBeGreaterThan(110)
  expect(replayScores('nba', [...history, delayed], new Map([[1, [{ at: afterCutoff, injuries: [] }]]]), [fixture]).fixtures.get(fixture.id)).toEqual(expected)
  const beforeCutoff = fixture.starts - 40 * 60_000
  const documented = replayScores('nba', history, new Map([[1, [{ at: beforeCutoff, injuries: [] }]]]), [fixture]).fixtures.get(fixture.id)
  expect(documented?.inputs.home.injuriesAsOf).toBe(beforeCutoff)
  expect(documented?.inputs.away.injuriesAsOf).toBeNull()
  expect(documented?.scores.injuries).toBeUndefined()
})

it('keeps the original score forecast through the game and never creates one after the deadline', async () => {
  const raw = schemaFor(':memory:', ['sports', 'sports_teams', 'market_events', 'event_results', 'team_injury_reports', 'game_score_forecasts'])
  const db = raw as unknown as Database
  const day = 86_400_000
  const start = Date.parse('2026-11-20T01:00:00.000Z')
  const iso = (ms: number) => new Date(ms).toISOString()
  const dbGame = raw.query(`INSERT INTO market_events (id, sport_id, title, commence_at, status, home_sports_team_id, away_sports_team_id)
    VALUES (?, 1, 'NBA game', ?, ?, 1, 2)`)
  try {
    raw.exec("INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nba', 'NBA', 'Basketball')")
    raw.exec("INSERT INTO sports_teams (id, sport_id, name, search_key) VALUES (1, 1, 'Home', 'home'), (2, 1, 'Away', 'away')")
    for (let days = 1; days <= 25; days++) {
      dbGame.run(days, iso(start - day * days), 'final')
      raw.query("INSERT INTO event_results (market_event_id, home_score, away_score, completed, source, settled_at) VALUES (?, 111, 102, 1, 'espn', ?)")
        .run(days, iso(start - day * days + 3_600_000))
    }
    dbGame.run(30, iso(start), 'scheduled')
    expect(await captureScoreForecasts(db, () => start - 29 * 60_000)).toEqual({ checked: 0, recorded: 0 })
    const at = start - 32 * 60_000
    expect(await captureScoreForecasts(db, () => at)).toEqual({ checked: 1, recorded: 1 })
    const saved = await recordedScoreForecast(db, 30, start)
    expect(saved).toMatchObject({ home: 111, away: 102, total: 213, capturedAt: iso(at) })
    expect(await captureScoreForecasts(db, () => at + 15_000)).toEqual({ checked: 0, recorded: 0 })
    raw.query("UPDATE market_events SET status = 'final' WHERE id = 30").run()
    expect(await recordedScoreForecast(db, 30, start)).toEqual(saved)
    expect(await recordedScoreForecast(db, 30, start + day)).toBeNull()
  }
  finally {
    raw.close()
  }
})
