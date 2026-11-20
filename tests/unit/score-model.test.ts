import type { Fixture, PlayedGame } from '../../app/Services/scores/score-model'
import { expect, it } from 'bun:test'
import { replayScores } from '../../app/Services/scores/score-model'

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
