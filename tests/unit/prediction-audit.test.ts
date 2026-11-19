import type { AuditGame, FrozenWinnerContext } from '../../app/Services/trading/prediction-audit'
import { describe, expect, it } from 'bun:test'
import { prospectiveSportsbookAudit, prospectiveWinnerAudit } from '../../app/Services/trading/prediction-audit'

describe('prospective winner audit', () => {
  it('runs the sportsbook-only audit at 50 settled forecasts even for games without team history', () => {
    const model = { trainBefore: '2026-11-19T02:00:00Z', trainingGames: 200, weights: [2, 0, 0, 0], weight: 1 }
    const at = Date.parse(model.trainBefore) + 60_000
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ticker: `game-${i}`, day: '2026-11-19', league: 'nba', at, settledAt: at + 500_000 + i,
      consensus: 0.49, outcome: 1 as const,
      context: i === 0 ? null : [1, 0, 0, 0] as [number, number, number, number],
    }))
    expect(prospectiveSportsbookAudit(rows.slice(0, -1), model, 50).scores).toBeNull()
    const report = prospectiveSportsbookAudit(rows, model, 50)
    expect(report.withContext).toBe(49)
    expect(report.scores?.books?.topThree.wins).toBe(0)
    expect(report.scores?.context?.topThree.wins).toBe(3)
  })

  it('compares the same first 50 paired settlements with a frozen model', () => {
    const model: FrozenWinnerContext = { trainBefore: '2026-11-19T02:00:00Z', trainingGames: 849, weights: [1, 0, 0, 0] }
    const cutoff = Date.parse(model.trainBefore)
    const eligible: AuditGame[] = Array.from({ length: 50 }, (_, i) => ({
      ticker: `game-${i}`,
      league: 'nba',
      day: '2026-11-19',
      at: cutoff + 60_000,
      settledAt: cutoff + 3_600_000 + i,
      bid: 0.48,
      ask: 0.50,
      consensus: 0.49,
      outcome: 1,
      context: [1, 0, 0, 0],
    }))
    const [game, ...rest] = eligible
    const other: AuditGame[] = [
      { ...game!, ticker: 'training-game', at: cutoff - 1 },
      { ...game!, ticker: 'no-books', consensus: null },
      { ...game!, ticker: 'no-context', context: null },
    ]
    expect(prospectiveWinnerAudit([...rest, ...other], model, 50)).toEqual({ eligible: 49, required: 50, scores: null })

    const settledLater: AuditGame = { ...game!, ticker: 'later', settledAt: cutoff + 3_700_000, outcome: 0 }
    const report = prospectiveWinnerAudit([settledLater, ...eligible, ...other], model, 50)
    expect(report.eligible).toBe(51)
    expect(report.scores?.blend?.games).toBe(50)
    expect(report.scores?.context?.games).toBe(50)
    expect(report.scores?.blend?.topThree.wins).toBe(0)
    expect(report.scores?.context?.topThree.wins).toBe(3)
  })
})
