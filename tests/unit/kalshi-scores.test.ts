import { describe, expect, it } from 'bun:test'
import fixtures from '../fixtures/kalshi-live-games.json'
import { gameFromMilestone } from '../../app/Services/scores/kalshi'

describe('Kalshi score fallback', () => {
  it('uses the milestone start rather than market expiration and never invents pregame scores', () => {
    const sample = fixtures[0]!
    const game = gameFromMilestone('nba', sample.milestone, sample.live)!
    expect(game.startsAt).toBe('2026-11-19T03:00:00Z')
    expect(game.state).toBe('pre')
    expect(game.home.score).toBeNull()
    expect(game.away.name).toBe('UTA Jazz')
  })

  it('reads final scores from live_data even when milestone metadata is stale', () => {
    const sample = fixtures[1]!
    const game = gameFromMilestone('nba', { ...sample.milestone, details: { status: 'scheduled' } }, sample.live)!
    expect(game.state).toBe('post')
    expect(game.home.score).toBe(102)
    expect(game.away.score).toBe(111)
  })

  it('does not present delayed scores as final or a cancelled game as live', () => {
    const sample = fixtures[1]!
    const game = gameFromMilestone('nba', sample.milestone, { live_data: { details: { ...sample.live.live_data.details, live_data_delayed: true } } })!
    expect(game.state).not.toBe('post')
    expect(game.status).toBe('Score feed delayed')
    expect(game.home.score).toBeNull()
    expect(gameFromMilestone('nba', sample.milestone, { live_data: { details: { status: 'cancelled' } } })!.state).toBe('pre')
  })
})
