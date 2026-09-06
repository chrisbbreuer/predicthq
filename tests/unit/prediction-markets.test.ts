/**
 * Prediction-markets pipeline tests.
 *
 * Exercises the winning-pattern analytics (fill scoring + trader
 * aggregates) and the Support query helpers against a throwaway SQLite
 * database created from the real migration files, so the SQL is tested
 * against the exact schema the app ships.
 */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { runAnalytics } from '../../app/Services/prediction-markets/analytics'
import { schemaFor } from '../support/schema'

const TABLES = ['prediction_markets', 'market_traders', 'market_trades']

let dir: string
let dbPath: string
let db: Database
let previousDbPath: string | undefined

function seed(database: Database): void {
  const now = '2026-07-07T00:00:00.000Z'
  const market = database.prepare(
    'INSERT INTO prediction_markets (venue, external_id, question, category, status, result, volume, liquidity, last_price, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  market.run('kalshi', 'MKT-YES', 'Settles yes?', '', 'settled', 'yes', 1000, 100, 0.99, now, now, now)
  market.run('kalshi', 'MKT-NO', 'Settles no?', '', 'settled', 'no', 2000, 200, 0.01, now, now, now)
  market.run('polymarket', '0xopen', 'Still open?', '', 'open', '', 500, 50, 0.5, now, now, now)

  const trader = database.prepare(
    'INSERT INTO market_traders (venue, external_id, alias, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  trader.run('polymarket', '0xaaa', 'sharp', now, now) // keeps buying winners
  trader.run('polymarket', '0xbbb', 'square', now, now) // keeps buying losers
  trader.run('polymarket', '0xccc', 'whale', now, now) // one huge open bet

  const trade = database.prepare(
    'INSERT OR IGNORE INTO market_trades (prediction_market_id, market_trader_id, venue, external_id, side, price, size, notional, is_winner, traded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, -1, ?, ?, ?)',
  )
  // sharp: 4 resolved, 4 wins (bought yes on the yes-market, no on the no-market)
  trade.run(1, 1, 'polymarket', 't1', 'yes', 0.60, 100, 60, now, now, now)
  trade.run(1, 1, 'polymarket', 't2', 'yes', 0.70, 100, 70, now, now, now)
  trade.run(2, 1, 'polymarket', 't3', 'no', 0.40, 100, 40, now, now, now)
  trade.run(2, 1, 'polymarket', 't4', 'no', 0.55, 100, 55, now, now, now)
  // sharp also has one open (unscoreable) fill
  trade.run(3, 1, 'polymarket', 't5', 'yes', 0.50, 100, 50, now, now, now)
  // square: 2 resolved, 0 wins
  trade.run(1, 2, 'polymarket', 't6', 'no', 0.30, 100, 30, now, now, now)
  trade.run(2, 2, 'polymarket', 't7', 'yes', 0.80, 100, 80, now, now, now)
  // whale: single huge fill on the open market
  trade.run(3, 3, 'polymarket', 't8', 'yes', 0.50, 30_000, 15_000, now, now, now)
  // anonymous kalshi fill (NULL trader) on a settled market
  trade.run(1, null, 'kalshi', 't9', 'yes', 0.45, 200, 90, now, now, now)
  // duplicate external id — must be ignored, not double-counted
  trade.run(1, 1, 'polymarket', 't1', 'yes', 0.60, 100, 60, now, now, now)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ob-pm-test-'))
  dbPath = join(dir, 'test.sqlite')
  db = schemaFor(dbPath, TABLES)
  seed(db)
  previousDbPath = process.env.DB_DATABASE_PATH
  process.env.DB_DATABASE_PATH = dbPath
  await runAnalytics(db)
})

afterAll(() => {
  db.close()
  if (previousDbPath === undefined)
    delete process.env.DB_DATABASE_PATH
  else
    process.env.DB_DATABASE_PATH = previousDbPath
  rmSync(dir, { recursive: true, force: true })
})

describe('unique dedupe index', () => {
  it('ignores a duplicate venue + external_id fill', () => {
    const { c } = db.query('SELECT COUNT(*) AS c FROM market_trades').get() as { c: number }
    expect(c).toBe(9) // 10 inserts, 1 duplicate dropped
  })
})

describe('runAnalytics — fill scoring', () => {
  it('marks fills on the winning side of settled markets as won', () => {
    const rows = db.query('SELECT external_id, is_winner FROM market_trades ORDER BY id').all() as Array<{ external_id: string, is_winner: number }>
    const byId = Object.fromEntries(rows.map(r => [r.external_id, r.is_winner]))
    expect(byId.t1).toBe(1)
    expect(byId.t2).toBe(1)
    expect(byId.t3).toBe(1)
    expect(byId.t4).toBe(1)
    expect(byId.t6).toBe(0)
    expect(byId.t7).toBe(0)
  })

  it('scores anonymous fills too (market-level flow)', () => {
    const t9 = db.query('SELECT is_winner FROM market_trades WHERE external_id = ?').get('t9') as { is_winner: number }
    expect(t9.is_winner).toBe(1)
  })

  it('leaves fills on open markets unscored', () => {
    const t5 = db.query('SELECT is_winner FROM market_trades WHERE external_id = ?').get('t5') as { is_winner: number }
    expect(t5.is_winner).toBe(-1)
  })
})

describe('runAnalytics — trader aggregates', () => {
  it('computes counts, win rate, and sizing for the sharp account', () => {
    const t = db.query('SELECT * FROM market_traders WHERE alias = ?').get('sharp') as any
    expect(t.trade_count).toBe(5)
    expect(t.resolved_trade_count).toBe(4)
    expect(t.winning_trade_count).toBe(4)
    expect(t.win_rate).toBe(1)
    expect(t.total_notional).toBe(275)
    expect(t.max_trade_size).toBe(70)
    // Bayesian shrink: ((4 + 3) / (4 + 6) - 0.5) * 200 = 40
    expect(t.smart_score).toBe(40)
    expect(t.is_whale).toBe(0)
  })

  it('gives a losing account a zero smart score, not a negative one', () => {
    const t = db.query('SELECT * FROM market_traders WHERE alias = ?').get('square') as any
    expect(t.win_rate).toBe(0)
    expect(t.smart_score).toBe(0)
  })

  it('flags a single 10k+ fill as a whale even with no resolved history', () => {
    const t = db.query('SELECT * FROM market_traders WHERE alias = ?').get('whale') as any
    expect(t.is_whale).toBe(1)
    expect(t.resolved_trade_count).toBe(0)
  })

  it('scores a bounded tranche instead of crossing the Vitess row ceiling', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'ob-pm-analytics-batch-'))
    const batchDb = schemaFor(join(batchDir, 'test.sqlite'), TABLES)

    try {
      const now = '2026-07-07T00:00:00.000Z'
      const market = batchDb.prepare(
        'INSERT INTO prediction_markets (venue, external_id, question, category, status, result, volume, liquidity, last_price, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('kalshi', 'batch-market', 'Batch market?', '', 'settled', 'yes', 1, 1, 1, now, now, now)
      const trade = batchDb.prepare(
        'INSERT INTO market_trades (prediction_market_id, market_trader_id, venue, external_id, side, price, size, notional, is_winner, traded_at, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, -1, ?, ?, ?)',
      )

      batchDb.exec('BEGIN')
      try {
        for (let index = 0; index < 10_050; index++)
          trade.run(Number(market.lastInsertRowid), 'kalshi', `batch-${index}`, 'yes', 0.5, 1, 0.5, now, now, now)
        batchDb.exec('COMMIT')
      }
      catch (error) {
        batchDb.exec('ROLLBACK')
        throw error
      }

      const result = await runAnalytics(batchDb, [])
      const remaining = batchDb.query('SELECT COUNT(*) AS c FROM market_trades WHERE is_winner = -1').get() as { c: number }
      expect(result.scoredTrades).toBe(2_000)
      expect(remaining.c).toBe(8_050)
    }
    finally {
      batchDb.close()
      rmSync(batchDir, { recursive: true, force: true })
    }
  })
})

describe('support query helpers', () => {
  it('loadSmartMoney ranks the sharp account first and includes the whale', async () => {
    const { loadSmartMoney } = await import('../../app/Support/prediction-markets')
    const traders = await loadSmartMoney(50, db)
    expect(traders[0].alias).toBe('sharp')
    expect(traders[0].winRate).toBe(1)
    expect(traders.some(t => t.alias === 'whale' && t.isWhale)).toBe(true)
    // square has 2 resolved fills, so it ranks (below sharp), win rate 0
    const square = traders.find(t => t.alias === 'square')
    expect(square?.winRate).toBe(0)
  })

  it('loadBigTrades orders by notional and labels anonymous fills', async () => {
    const { loadBigTrades } = await import('../../app/Support/prediction-markets')
    const trades = await loadBigTrades(3, db)
    expect(trades[0].notional).toBe(15_000)
    const anon = (await loadBigTrades(20, db)).find(t => t.venue === 'kalshi')
    expect(anon?.alias).toBe('')
  })

  it('loadGraph returns trader + market nodes and notional-weighted links', async () => {
    const { loadGraph } = await import('../../app/Support/prediction-markets')
    const graph = await loadGraph(40, db)
    const traderNodes = graph.nodes.filter(n => n.kind === 'trader')
    const marketNodes = graph.nodes.filter(n => n.kind === 'market')
    expect(traderNodes.length).toBe(3)
    expect(marketNodes.length).toBe(3)
    // sharp is a "smart" group node (score 40 ≥ 25 with enough history)
    const sharp = traderNodes.find(n => n.label === 'sharp')
    expect(sharp?.group).toBe('smart')
    // the sharp→MKT-YES flow aggregates t1 + t2 (60 + 70) and is all wins
    const link = graph.links.find(l => l.source === sharp!.id && l.target === `m:1`)
    expect(link?.value).toBe(130)
    expect(link?.trades).toBe(2)
    expect(link?.wins).toBe(2)
    expect(link?.losses).toBe(0)
    expect(() => JSON.stringify(graph)).not.toThrow()
  })

  it('caps the public graph before Vitess reaches its result-row ceiling', async () => {
    const capDir = mkdtempSync(join(tmpdir(), 'ob-pm-graph-cap-'))
    const capDb = schemaFor(join(capDir, 'test.sqlite'), TABLES)

    try {
      seed(capDb)
      await runAnalytics(capDb)

      const now = '2026-07-07T00:00:00.000Z'
      const market = capDb.prepare(
        'INSERT INTO prediction_markets (venue, external_id, question, category, status, result, volume, liquidity, last_price, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const trade = capDb.prepare(
        'INSERT INTO market_trades (prediction_market_id, market_trader_id, venue, external_id, side, price, size, notional, is_winner, traded_at, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, -1, ?, ?, ?)',
      )

      for (let index = 0; index < 200; index++) {
        const result = market.run('polymarket', `cap-market-${index}`, `Cap market ${index}?`, '', 'open', '', 1000 + index, 100, 0.5, now, now, now)
        trade.run(Number(result.lastInsertRowid), 'polymarket', `cap-trade-${index}`, 'yes', 0.5, 10, 5 + index, now, now, now)
      }

      const { loadGraph } = await import('../../app/Support/prediction-markets')
      const graph = await loadGraph(40, capDb)
      expect(graph.links).toHaveLength(160)
      expect(graph.nodes.length).toBeLessThanOrEqual(200)
    }
    finally {
      capDb.close()
      rmSync(capDir, { recursive: true, force: true })
    }
  })
})
