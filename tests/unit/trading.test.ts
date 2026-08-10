/**
 * Trading engine tests.
 *
 * Covers the three places a mistake costs money rather than a bad page:
 * the evidence scoring that decides fair value, the Kelly sizing that
 * decides how much, and the entitlement check that decides whether an
 * order may be placed at all.
 *
 * Runs against a throwaway SQLite database built from the real migration
 * files, so the SQL is exercised against the exact schema the app ships.
 */

import type { Candidate } from '../../app/Services/trading/evidence'
import type { Strategy } from '../../app/Services/trading/execute'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { entitlementsFor, tierFrom } from '../../app/Services/billing/entitlements'
import { buildCandidates } from '../../app/Services/trading/evidence'
import { stakeFor } from '../../app/Services/trading/execute'
import { schemaFor } from '../support/schema'

const TABLES = ['prediction_markets', 'market_traders', 'market_trades', 'subscriptions']

let dir: string
let db: Database

/** Fills spread across the window so the trend query has both buckets. */
function insertFills(
  database: Database,
  marketId: number,
  side: string,
  count: number,
  price: number,
  notional: number,
  traderId: number | null,
  hoursAgo: number,
): void {
  const insert = database.prepare(`
    INSERT INTO market_trades (
      prediction_market_id, market_trader_id, venue, external_id, side,
      price, size, notional, traded_at, is_winner, created_at, updated_at
    ) VALUES (?, ?, 'polymarket', ?, ?, ?, ?, ?, ?, -1, ?, ?)
  `)

  const now = Date.now()
  for (let i = 0; i < count; i++) {
    const at = new Date(now - hoursAgo * 3600_000 - i * 60_000).toISOString()
    insert.run(
      marketId,
      traderId,
      `fill-${marketId}-${side}-${hoursAgo}-${i}`,
      side,
      price,
      notional / price,
      notional,
      at,
      at,
      at,
    )
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-trading-'))
  db = schemaFor(join(dir, 'test.sqlite'), TABLES)

  const now = new Date().toISOString()
  const market = db.prepare(`
    INSERT INTO prediction_markets (
      venue, external_id, question, category, status, result,
      volume, liquidity, last_price, ends_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
  `)

  // 1 — heavy, accurate flow into yes against a 50c quote.
  market.run('polymarket', '0xlopsided', 'Lopsided?', 'Politics', 'open', 100_000, 5000, 0.5, now, now, now)
  // 2 — enough fills, but split evenly, so nothing to say.
  market.run('polymarket', '0xbalanced', 'Balanced?', 'Politics', 'open', 50_000, 2000, 0.5, now, now, now)
  // 3 — too few fills to model at all.
  market.run('polymarket', '0xthin', 'Thin?', 'Crypto', 'open', 900, 100, 0.5, now, now, now)

  const trader = db.prepare(`
    INSERT INTO market_traders (
      venue, external_id, alias, smart_score, created_at, updated_at
    ) VALUES ('polymarket', ?, ?, ?, ?, ?)
  `)
  trader.run('0xsharp', 'sharp', 85, now, now)
  trader.run('0xnoise', 'noise', 5, now, now)

  // Market 1: 30 yes fills from the sharp account, 6 no fills from noise.
  insertFills(db, 1, 'yes', 20, 0.5, 400, 1, 10)
  insertFills(db, 1, 'yes', 10, 0.56, 400, 1, 1)
  insertFills(db, 1, 'no', 6, 0.5, 100, 2, 8)

  // Market 2: evenly split, same account quality on both sides.
  insertFills(db, 2, 'yes', 10, 0.5, 200, 2, 6)
  insertFills(db, 2, 'no', 10, 0.5, 200, 2, 6)

  // Market 3: below the MIN_FILLS floor.
  insertFills(db, 3, 'yes', 3, 0.5, 100, 1, 5)
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('evidence', () => {
  it('favours the side carrying the accurate money', async () => {
    const candidates = await buildCandidates(db, { minEdge: 0 })
    const lopsided = candidates.find(c => c.externalId === '0xlopsided')

    expect(lopsided).toBeDefined()
    expect(lopsided!.side).toBe('yes')
    // Fair value moved off the quote, in the direction of the flow.
    expect(lopsided!.fairValue).toBeGreaterThan(lopsided!.marketPrice)
    expect(lopsided!.edge).toBeGreaterThan(0)
  })

  it('records the evidence that moved fair value', async () => {
    const candidate = (await buildCandidates(db, { minEdge: 0 })).find(c => c.externalId === '0xlopsided')!
    const kinds = candidate.evidence.map(e => e.kind)

    expect(kinds).toContain('flow_imbalance')
    expect(kinds).toContain('smart_money')
    expect(kinds).toContain('liquidity')

    // Fair value has to be exactly the quote plus the contributions —
    // this is the invariant that makes a decision reconstructible.
    const total = candidate.evidence.reduce((sum, e) => sum + e.contribution, 0)
    expect(candidate.fairValue).toBeCloseTo(candidate.marketPrice + total, 3)
  })

  it('reports liquidity without letting it argue a direction', async () => {
    const candidate = (await buildCandidates(db, { minEdge: 0 })).find(c => c.externalId === '0xlopsided')!
    const liquidity = candidate.evidence.find(e => e.kind === 'liquidity')!

    expect(liquidity.value).toBeGreaterThan(0)
    expect(liquidity.contribution).toBe(0)
  })

  it('skips markets with too few fills to model', async () => {
    const candidates = await buildCandidates(db, { minEdge: 0 })
    expect(candidates.some(c => c.externalId === '0xthin')).toBe(false)
  })

  it('finds no edge worth taking in balanced flow', async () => {
    const candidates = await buildCandidates(db, { minEdge: 0.03 })
    expect(candidates.some(c => c.externalId === '0xbalanced')).toBe(false)
  })

  it('honours the venue and category filters', async () => {
    expect(await buildCandidates(db, { minEdge: 0, venues: ['kalshi'] })).toHaveLength(0)
    expect((await buildCandidates(db, { minEdge: 0, categories: ['politics'] })).length).toBeGreaterThan(0)
  })

  it('never lets one signal run away with fair value', async () => {
    for (const candidate of await buildCandidates(db, { minEdge: 0 })) {
      for (const item of candidate.evidence)
        expect(Math.abs(item.contribution)).toBeLessThanOrEqual(0.08)

      expect(Math.abs(candidate.fairValue - candidate.marketPrice)).toBeLessThanOrEqual(0.1501)
    }
  })
})

describe('sizing', () => {
  const strategy: Strategy = {
    id: 1,
    user_id: 1,
    venue: 'both',
    bankroll: 1000,
    max_stake: 100,
    min_edge: 0.02,
    min_confidence: 0.5,
    max_open_positions: 10,
    daily_loss_limit: 250,
    cumulative_loss_limit: 0,
    auto_execute: 1,
    status: 'active',
  }

  function candidate(overrides: Partial<Candidate> = {}): Candidate {
    return {
      predictionMarketId: 1,
      venue: 'polymarket',
      externalId: '0x',
      question: 'q',
      category: 'Politics',
      side: 'yes',
      marketPrice: 0.5,
      fairValue: 0.6,
      edge: 0.1,
      confidence: 0.8,
      liquidity: 5000,
      evidence: [],
      ...overrides,
    }
  }

  it('stakes more on a bigger edge', () => {
    const small = stakeFor(candidate({ fairValue: 0.55, edge: 0.05 }), strategy, 1000)
    const large = stakeFor(candidate({ fairValue: 0.7, edge: 0.2 }), strategy, 1000)

    expect(large).toBeGreaterThan(small)
  })

  it('scales the stake down with confidence', () => {
    const sure = stakeFor(candidate({ confidence: 0.9 }), strategy, 1000)
    const unsure = stakeFor(candidate({ confidence: 0.3 }), strategy, 1000)

    expect(unsure).toBeLessThan(sure)
  })

  it('never stakes on a negative edge', () => {
    expect(stakeFor(candidate({ fairValue: 0.4, edge: -0.1 }), strategy, 1000)).toBe(0)
  })

  it('respects the per-trade cap even on a huge edge', () => {
    const stake = stakeFor(candidate({ fairValue: 0.99, edge: 0.49, confidence: 1 }), strategy, 1_000_000)
    expect(stake).toBeLessThanOrEqual(strategy.max_stake)
  })

  it('never stakes more than the bankroll left', () => {
    expect(stakeFor(candidate(), strategy, 5)).toBeLessThanOrEqual(5)
  })

  it('stays clear of a degenerate price', () => {
    expect(stakeFor(candidate({ marketPrice: 1 }), strategy, 1000)).toBe(0)
    expect(stakeFor(candidate({ marketPrice: 0 }), strategy, 1000)).toBe(0)
  })
})

describe('entitlements', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const past = new Date(Date.now() - 86_400_000).toISOString()

  // `provider_id` is unique in the schema — Stripe never reuses a
  // subscription id, and the "two live subscriptions" case below needs
  // two distinct ones for the same user, so the counter is not cosmetic.
  let providerSeq = 0

  function subscribe(userId: number, priceKey: string, status: string, endsAt: string | null): void {
    providerSeq++
    // `unit_price` and `provider_type` are NOT NULL: the Subscription
    // model declares both required, and the schema now reflects that.
    // Entitlements are decided from the price key rather than either
    // value, so fixed placeholders serve here.
    db.prepare(`
      INSERT INTO subscriptions
        (type, plan, provider_id, provider_status, provider_type, provider_price_id, unit_price, user_id, ends_at)
      VALUES ('default', ?, ?, ?, 'stripe', ?, 0, ?, ?)
    `).run(priceKey, `sub_${providerSeq}`, status, priceKey, userId, endsAt)
  }

  it('maps price keys onto tiers', () => {
    expect(tierFrom('predicthq_signal_monthly')).toBe('signal')
    expect(tierFrom('predicthq_auto_yearly')).toBe('auto')
    expect(tierFrom('predicthq_desk_monthly')).toBe('desk')
    expect(tierFrom('something_else')).toBe('none')
  })

  it('entitles nobody without a subscription', async () => {
    const entitlements = await entitlementsFor(db, 999)
    expect(entitlements.tier).toBe('none')
    expect(entitlements.canAutoExecute).toBe(false)
  })

  it('lets Signal read but not trade', async () => {
    subscribe(10, 'predicthq_signal_monthly', 'active', null)
    const entitlements = await entitlementsFor(db, 10)

    expect(entitlements.tier).toBe('signal')
    expect(entitlements.canAutoExecute).toBe(false)
    expect(entitlements.maxStrategies).toBe(1)
  })

  it('lets Auto trade', async () => {
    subscribe(11, 'predicthq_auto_monthly', 'active', null)
    expect((await entitlementsFor(db, 11)).canAutoExecute).toBe(true)
  })

  it('gives Desk unlimited strategies', async () => {
    subscribe(12, 'predicthq_desk_yearly', 'active', null)
    expect((await entitlementsFor(db, 12)).maxStrategies).toBeNull()
  })

  it('stops entitling once a failed payment goes past due', async () => {
    subscribe(13, 'predicthq_auto_monthly', 'past_due', null)
    expect((await entitlementsFor(db, 13)).canAutoExecute).toBe(false)
  })

  it('keeps a cancelled subscription until its period ends', async () => {
    subscribe(14, 'predicthq_auto_monthly', 'active', future)
    expect((await entitlementsFor(db, 14)).canAutoExecute).toBe(true)

    subscribe(15, 'predicthq_auto_monthly', 'active', past)
    expect((await entitlementsFor(db, 15)).tier).toBe('none')
  })

  it('takes the better of two live subscriptions', async () => {
    subscribe(16, 'predicthq_signal_monthly', 'active', null)
    subscribe(16, 'predicthq_desk_monthly', 'active', null)
    expect((await entitlementsFor(db, 16)).tier).toBe('desk')
  })

  it('counts a trial as live', async () => {
    subscribe(17, 'predicthq_auto_monthly', 'trialing', null)
    expect((await entitlementsFor(db, 17)).canAutoExecute).toBe(true)
  })
})
