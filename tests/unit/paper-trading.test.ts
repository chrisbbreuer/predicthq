/**
 * Paper trading.
 *
 * The argument for paper mode is that its record is comparable to a live
 * one, which only holds if it books into the same positions and refuses
 * the fills a real order would not have got. A simulator that fills
 * everything at the quoted price produces a track record that is
 * confidently wrong, which is worse than no track record.
 */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { executePaper } from '../../app/Services/trading/paper'
import { settlePositions } from '../../app/Services/trading/positions'
import { schemaFor } from '../support/schema'

const TABLES = [
  'exchange_orders',
  'exchange_positions',
  'trade_decisions',
  'trading_strategies',
  'prediction_markets',
]

let dir: string
let db: Database

const strategy = {
  id: 1,
  user_id: 1,
  venue: 'kalshi',
  mode: 'paper',
  bankroll: 1000,
  max_stake: 100,
  min_edge: 0.04,
  min_confidence: 0.6,
  max_open_positions: 10,
  daily_loss_limit: 250,
  cumulative_loss_limit: 0,
  auto_execute: 1,
  status: 'active',
}

/** A market quoted at `lastPrice`, and a decision limited at `limit`. */
function seed(lastPrice: number, limit: number): void {
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO trading_strategies (
      id, user_id, name, venue, mode, categories, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, auto_execute, status, halted_reason, last_run_at,
      created_at, updated_at
    ) VALUES (1, 1, 'Paper', 'kalshi', 'paper', '', 1000, 100, 0.04, 0.6, 10, 250, 1, 'active', '', '', ?, ?)
  `).run(now, now)

  db.prepare(`
    INSERT INTO prediction_markets (
      id, venue, external_id, question, outcome_label, category, status, result,
      volume, liquidity, last_price, ends_at, created_at, updated_at
    ) VALUES (1, 'kalshi', 'TICKER-A', 'Will it?', '', 'Politics', 'open', '', 1000, 500, ?, ?, ?, ?)
  `).run(lastPrice, now, now, now)

  db.prepare(`
    INSERT INTO trade_decisions (
      id, trading_strategy_id, prediction_market_id, venue, side, market_price, fair_value,
      edge, confidence, limit_price, size, notional, rationale, decided_by, status,
      status_reason, created_at, updated_at
    ) VALUES (1, 1, 1, 'kalshi', 'yes', ?, 0.7, 0.1, 0.8, ?, 100, ?, '', 'rules', 'approved', '', ?, ?)
  `).run(lastPrice, limit, limit * 100, now, now)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-paper-'))
  db = schemaFor(join(dir, 'test.sqlite'), TABLES)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('paper fills', () => {
  it('fills inside the limit, and pays a spread for the privilege', async () => {
    seed(0.5, 0.6)

    const [outcome] = await executePaper(db as any, strategy, [1])

    expect(outcome!.placed).toBe(true)

    const [position]: any[] = db.prepare('SELECT * FROM exchange_positions').all()
    // 50c quoted plus the assumed cent, not the 50c we would like.
    expect(position.avg_price).toBeCloseTo(0.51, 5)
    expect(position.cost_basis).toBeCloseTo(51, 5)
  })

  it('never pays more than the limit, whatever the spread assumption', async () => {
    // A limit only half a cent above the quote: slippage would carry the
    // fill past it, and the limit is what it is for.
    seed(0.5, 0.505)

    await executePaper(db as any, strategy, [1])

    const [position]: any[] = db.prepare('SELECT * FROM exchange_positions').all()
    expect(position.avg_price).toBeCloseTo(0.505, 5)
  })

  it('refuses a fill the market never offered', async () => {
    seed(0.7, 0.6)

    const [outcome] = await executePaper(db as any, strategy, [1])

    expect(outcome!.placed).toBe(false)
    expect(outcome!.reason).toContain('never traded down')
    expect(db.prepare('SELECT * FROM exchange_positions').all()).toHaveLength(0)
  })

  it('marks its orders so they cannot be mistaken for real ones', async () => {
    seed(0.5, 0.6)

    await executePaper(db as any, strategy, [1])

    const [order]: any[] = db.prepare('SELECT * FROM exchange_orders').all()
    expect(order.venue).toBe('paper:kalshi')
    // No account, which is also what keeps reconciliation away from it:
    // there is no venue to ask about an order that was never sent.
    expect(order.exchange_account_id).toBeNull()
  })

  it('settles by the same rule a live position does', async () => {
    seed(0.5, 0.6)
    await executePaper(db as any, strategy, [1])

    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'yes\' WHERE id = 1').run()
    const summary = await settlePositions(db as any)

    expect(summary.settled).toBe(1)
    // 100 contracts at 51c, paid out at a dollar.
    expect(summary.realized).toBeCloseTo(49, 5)
  })
})
