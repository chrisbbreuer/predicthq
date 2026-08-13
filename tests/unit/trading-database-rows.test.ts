import { describe, expect, it } from 'bun:test'
import { normalizeStrategyRow } from '../../app/Services/trading/run'

describe('production trading database rows', () => {
  it('normalizes Vitess decimal strings before strategy arithmetic and formatting', () => {
    const strategy = normalizeStrategyRow({
      id: '1',
      user_id: '2',
      venue: 'kalshi',
      mode: 'paper',
      bankroll: '20.00',
      max_stake: '2.00',
      min_edge: '0.04',
      min_confidence: '0.65',
      max_open_positions: '4.00',
      daily_loss_limit: '5.00',
      cumulative_loss_limit: '10.00',
      auto_execute: '1',
      status: 'active',
    })

    expect(strategy).toMatchObject({
      id: 1,
      user_id: 2,
      bankroll: 20,
      max_stake: 2,
      min_edge: 0.04,
      min_confidence: 0.65,
      max_open_positions: 4,
      daily_loss_limit: 5,
      cumulative_loss_limit: 10,
      auto_execute: 1,
    })
    expect(strategy.min_confidence.toFixed(2)).toBe('0.65')
  })
})
