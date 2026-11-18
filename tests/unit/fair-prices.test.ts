import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { computeFairPrices } from '../../app/Services/quant/fair'
import { schemaFor } from '../support/schema'

/**
 * The fair-price pass reads quotes a page of markets at a time. One query
 * over every quote passed Vitess's 10,000-row cap once the exchanges joined
 * the feed, and failed the whole pipeline on every run.
 */

const TABLES = ['sports', 'sports_teams', 'market_events', 'markets', 'selections', 'bookmakers', 'odds', 'fair_prices']

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal'])
      rmSync(`${path}${suffix}`, { force: true })
  }
})

function seed(markets: number, status: (marketId: number) => string = () => 'scheduled', commence: (marketId: number) => string = () => '2099-12-01T00:00:00.000Z') {
  const path = `tests/temp/fair-${paths.length}-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  const db = schemaFor(path, TABLES)
  db.run(`INSERT INTO sports (id, slug, title, grouping, active, position) VALUES (1, 'nba', 'NBA', 'Basketball', 1, 1)`)
  db.run(`INSERT INTO bookmakers (id, slug, short, name, active, sharp, consensus_weight) VALUES (1, 'pin', 'PIN', 'Pinnacle', 1, 1, 1.0), (2, 'dk', 'DK', 'DraftKings', 1, 0, 0.5)`)
  db.run('BEGIN')
  for (let m = 1; m <= markets; m++) {
    db.run(`INSERT INTO market_events (id, sport_id, title, commence_at, status) VALUES (?, 1, 'A at B', ?, ?)`, [m, commence(m), status(m)])
    db.run(`INSERT INTO markets (id, market_event_id, market_type, line, line_key, period, complete, status, position) VALUES (?, ?, 'h2h', NULL, '', 'full_game', 1, 'open', 0)`, [m, m])
    for (const [offset, side] of [[1, 'home'], [2, 'away']] as const) {
      const selection = m * 2 - 2 + offset
      db.run(`INSERT INTO selections (id, market_id, label, side, point, point_key, position, outcome, graded_at) VALUES (?, ?, ?, ?, NULL, '', ?, -1, '')`, [selection, m, side, side, offset])
      // DraftKings has the better away price, written as text the way Vitess returns DECIMAL.
      db.run(`INSERT INTO odds (selection_id, bookmaker_id, price, available, created_at, updated_at) VALUES (?, 1, ?, 1, '', '')`, [selection, side === 'home' ? 1.9 : 1.95])
      db.run(`INSERT INTO odds (selection_id, bookmaker_id, price, available, created_at, updated_at) VALUES (?, 2, ?, 1, '', '')`, [selection, side === 'home' ? '1.85' : '10.5'])
    }
  }
  db.run('COMMIT')
  return db
}

describe('computeFairPrices', () => {
  it('prices every market across several pages', async () => {
    const db = seed(901)
    const result = await computeFairPrices(db)
    expect(result.markets).toBe(901)
    expect(result.selections).toBe(1802)
    const count = db.query('SELECT COUNT(*) AS n FROM fair_prices').get() as { n: number }
    expect(count.n).toBe(1802)
    db.close()
  })

  it('leaves finished games alone', async () => {
    const db = seed(4, id => (id === 2 ? 'final' : id === 3 ? 'cancelled' : id === 4 ? 'live' : 'scheduled'))
    const result = await computeFairPrices(db)
    expect(result.markets).toBe(2)
    const priced = (db.query('SELECT selection_id FROM fair_prices ORDER BY selection_id').all() as Array<{ selection_id: number }>).map(r => r.selection_id)
    expect(priced).toEqual([1, 2, 7, 8])
    db.close()
  })

  it('leaves a game whose final never arrived alone', async () => {
    const db = seed(2, () => 'scheduled', id => (id === 1 ? '2026-08-21T00:00:00.000Z' : '2099-12-01T00:00:00.000Z'))
    const result = await computeFairPrices(db)
    expect(result.markets).toBe(1)
    db.close()
  })

  it('picks the best price by number, not by text', async () => {
    const db = seed(1)
    await computeFairPrices(db)
    const away = db.query('SELECT best_price, best_bookmaker_id FROM fair_prices WHERE selection_id = 2').get() as { best_price: number, best_bookmaker_id: number }
    expect(Number(away.best_price)).toBe(10.5)
    expect(away.best_bookmaker_id).toBe(2)
    db.close()
  })

  it('restricts to the markets asked for', async () => {
    const db = seed(5)
    const result = await computeFairPrices(db, { marketIds: [2, 5] })
    expect(result.markets).toBe(2)
    db.close()
  })
})
