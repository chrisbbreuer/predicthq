import type { Database } from 'bun:sqlite'
import type { PlaceOrderRequest, PlaceOrderResult, TradingClient, VenueBalance, VenuePosition } from '../../app/Services/trading/venue'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadStrategyForReview } from '../../app/Actions/Trading/ReviewDecision'
import { clientOrderIdFor, executeStrategy, liveAccessReason, type Strategy } from '../../app/Services/trading/execute'
import { schemaFor } from '../support/schema'

const TABLES = [
  'exchange_orders',
  'exchange_accounts',
  'exchange_positions',
  'trade_decisions',
  'trading_strategies',
  'prediction_markets',
  'trading_halts',
]

let dir: string
let db: Database

class StubVenue implements TradingClient {
  readonly venue = 'kalshi' as const
  placed: PlaceOrderRequest[] = []

  constructor(private readonly available = 20) {}

  async fetchBalance(): Promise<VenueBalance> {
    return { available: this.available }
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    return []
  }

  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    this.placed.push(request)
    return { externalOrderId: 'venue-1', status: 'open', filledSize: 0, avgFillPrice: 0 }
  }

  async fetchOrder(): Promise<PlaceOrderResult | null> {
    return null
  }

  async cancelOrder(): Promise<boolean> {
    return true
  }
}

function seed(mode = 'live', cumulativeLossLimit = 5): Strategy {
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO trading_strategies (
      id, user_id, name, venue, mode, categories, bankroll, max_stake, min_edge,
      min_confidence, max_open_positions, daily_loss_limit, cumulative_loss_limit,
      auto_execute, status, halted_reason, last_run_at, created_at, updated_at
    ) VALUES (1, 1, 'Twenty dollar trial', 'kalshi', ?, '', 20, 1, 0.08,
      0.8, 2, 2, ?, 1, 'active', '', '', ?, ?)
  `).run(mode, cumulativeLossLimit, now, now)

  db.prepare(`
    INSERT INTO exchange_accounts (
      id, user_id, venue, label, credentials, masked_identifier, status, balance,
      last_error, last_synced_at, created_at, updated_at
    ) VALUES (1, 1, 'kalshi', 'trial', 'sealed', '…test', 'active', 20, '', '', ?, ?)
  `).run(now, now)

  db.prepare(`
    INSERT INTO prediction_markets (
      id, venue, external_id, question, outcome_label, category, status, result,
      volume, liquidity, last_price, ends_at, created_at, updated_at
    ) VALUES (1, 'kalshi', 'TICKER-A', 'Will it?', '', 'Politics', 'open', '',
      1000, 500, 0.5, ?, ?, ?)
  `).run(now, now, now)

  db.prepare(`
    INSERT INTO trade_decisions (
      id, trading_strategy_id, prediction_market_id, venue, side, market_price,
      fair_value, edge, confidence, limit_price, size, notional, rationale,
      decided_by, status, status_reason, created_at, updated_at
    ) VALUES (1, 1, 1, 'kalshi', 'yes', 0.5, 0.6, 0.1, 0.8, 0.55,
      1, 0.55, '', 'rules', 'approved', '', ?, ?)
  `).run(now, now)

  return {
    id: 1,
    user_id: 1,
    venue: 'kalshi',
    mode,
    bankroll: 20,
    max_stake: 1,
    min_edge: 0.08,
    min_confidence: 0.8,
    max_open_positions: 2,
    daily_loss_limit: 2,
    cumulative_loss_limit: cumulativeLossLimit,
    auto_execute: 1,
    status: 'active',
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-execution-'))
  db = schemaFor(join(dir, 'test.sqlite'), TABLES)
  process.env.APP_ENV = 'test'
  process.env.PRINTEL_DEV_TIER = 'auto'
  delete process.env.TRADING_ENABLED
  delete process.env.TRADING_BANKROLL_CAP_USD
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  process.env.APP_ENV = 'test'
  delete process.env.PRINTEL_DEV_TIER
  delete process.env.TRADING_ENABLED
  delete process.env.TRADING_BANKROLL_CAP_USD
})

describe('live placement safety', () => {
  it('claims a decision once under concurrent approvals', async () => {
    const strategy = seed()
    const venue = new StubVenue()
    const options = { clientFor: async () => venue }

    await Promise.all([
      executeStrategy(db as any, strategy, [1], options),
      executeStrategy(db as any, strategy, [1], options),
    ])

    expect(venue.placed).toHaveLength(1)
    expect(venue.placed[0]!.clientOrderId).toBe(clientOrderIdFor(1, 1))
    expect(db.prepare('SELECT * FROM exchange_orders').all()).toHaveLength(1)
  })

  it('checks the current venue balance before placing', async () => {
    const strategy = seed()
    const venue = new StubVenue(0.25)

    const [outcome] = await executeStrategy(db as any, strategy, [1], { clientFor: async () => venue })

    expect(outcome!.placed).toBe(false)
    expect(outcome!.reason).toContain('venue has $0.25 available')
    expect(venue.placed).toHaveLength(0)
  })

  it('keeps concurrent orders inside the deployment bankroll cap', async () => {
    const strategy = seed()
    const now = new Date().toISOString()
    process.env.TRADING_BANKROLL_CAP_USD = '0.75'
    db.prepare(`
      INSERT INTO trade_decisions (
        id, trading_strategy_id, prediction_market_id, venue, side, market_price,
        fair_value, edge, confidence, limit_price, size, notional, rationale,
        decided_by, status, status_reason, created_at, updated_at
      ) VALUES (2, 1, 1, 'kalshi', 'yes', 0.5, 0.6, 0.1, 0.8, 0.55,
        1, 0.55, '', 'rules', 'approved', '', ?, ?)
    `).run(now, now)
    const venue = new StubVenue()

    const batches = await Promise.all([
      executeStrategy(db as any, strategy, [1], { clientFor: async () => venue }),
      executeStrategy(db as any, strategy, [2], { clientFor: async () => venue }),
    ])

    expect(venue.placed.length).toBeLessThanOrEqual(1)
    expect(batches.flat().some(outcome => outcome.reason.includes('bankroll cap'))).toBe(true)
  })

  it('halts after the all-time campaign loss ceiling', async () => {
    const strategy = seed('live', 5)
    strategy.daily_loss_limit = 0
    const now = new Date().toISOString()

    db.prepare(`
      INSERT INTO exchange_positions (
        trading_strategy_id, exchange_account_id, prediction_market_id, venue,
        market_external_id, side, size, cost_basis, avg_price, realized_pnl,
        status, settlement_price, opened_at, settled_at, created_at, updated_at
      ) VALUES (1, 1, 1, 'kalshi', 'OLD', 'yes', 10, 6, 0.6, -6,
        'settled', 0, ?, ?, ?, ?)
    `).run(now, now, now, now)

    const [outcome] = await executeStrategy(db as any, strategy, [1], { clientFor: async () => new StubVenue() })

    expect(outcome!.placed).toBe(false)
    expect(outcome!.reason).toContain('cumulative loss limit reached')
    expect(db.prepare('SELECT status FROM trading_strategies WHERE id = 1').get() as any).toMatchObject({ status: 'halted' })
  })

  it('keeps paper trading available while production live trading is disabled', async () => {
    const strategy = seed('paper')
    process.env.APP_ENV = 'production'

    const [outcome] = await executeStrategy(db as any, strategy, [1], {
      clientFor: async () => { throw new Error('paper must not open a venue') },
    })

    expect(outcome!.placed).toBe(true)
    expect((db.prepare('SELECT venue FROM exchange_orders').get() as any).venue).toBe('paper:kalshi')
  })
})

describe('manual review', () => {
  it('loads the paper/live mode instead of defaulting a paper strategy to live', async () => {
    seed('paper')

    const strategy = await loadStrategyForReview(db as any, 1)

    expect(strategy?.mode).toBe('paper')
    expect(strategy?.cumulative_loss_limit).toBe(5)
  })
})

describe('controlled production rollout', () => {
  it('allows only named testers until public live trading is explicitly enabled', () => {
    const env = {
      APP_ENV: 'production',
      PUBLIC_LIVE_TRADING_ENABLED: 'false',
      LIVE_TRADING_USER_ALLOWLIST: '7, 12',
    }
    expect(liveAccessReason(7, env)).toBe('')
    expect(liveAccessReason(8, env)).toContain('controlled launch allowlist')
    expect(liveAccessReason(8, { ...env, PUBLIC_LIVE_TRADING_ENABLED: 'true' })).toBe('')
  })
})
