import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import { writeCoverage, writePrices } from '../../app/Services/ingest/prices'
import { historicalBoard } from '../../app/Services/quant/history'
import { schemaFor } from '../support/schema'

/**
 * The single writer for prices, now that it writes in batches.
 *
 * Two properties matter and neither is obvious from reading the code.
 *
 * History is a **change log**: a poll that finds the same price must add
 * nothing. At one pass every five minutes a bug here was a slow leak; at
 * one pass a second it fills the table in an afternoon, and every
 * "the line moved" number computed from it becomes noise.
 *
 * And the batch must survive a provider repeating itself. Two quotes for
 * the same selection and book in one call used to be two sequential
 * writes; in a single multi-row statement it is a duplicate conflict key,
 * which SQLite and Postgres reject outright.
 */

const TABLES = [
  'sports', 'sports_teams', 'market_events', 'markets', 'selections',
  'bookmakers', 'odds', 'odds_snapshots', 'sportsbook_quote_observations', 'book_market_coverage',
]

const paths: string[] = []

function freshDb() {
  const path = `tests/temp/prices-${paths.length}-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  const db = schemaFor(path, TABLES)

  db.exec(`INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nfl', 'NFL', 'Football')`)
  db.exec(`INSERT INTO market_events (id, title, commence_at, sport_id) VALUES (1, 'A at B', '2026-08-07T00:00:00.000Z', 1)`)
  db.exec(`INSERT INTO markets (id, market_type, line_key, period, market_event_id) VALUES (1, 'h2h', '', 'full_game', 1)`)
  db.exec(`INSERT INTO selections (id, label, side, point_key, market_id) VALUES (1, 'A', 'home', '', 1), (2, 'B', 'away', '', 1)`)
  db.exec(`INSERT INTO bookmakers (id, name, slug) VALUES (1, 'Pinnacle', 'pinnacle'), (2, 'DraftKings', 'draftkings')`)

  return db
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal'])
      rmSync(`${path}${suffix}`, { force: true })
  }
})

function countSnapshots(db: ReturnType<typeof freshDb>): number {
  return (db.query('SELECT COUNT(*) AS n FROM odds_snapshots').get() as { n: number }).n
}

/**
 * Put a measurable gap between two passes.
 *
 * `captured_at` has millisecond resolution and is the third column of the
 * snapshot unique index, so two passes inside the same millisecond are
 * deliberately collapsed into one row — that is the idempotency guarantee
 * doing its job, not a lost movement. Tests run far faster than the poller
 * ever will, so without this they race the clock and assert whichever
 * answer they happened to get.
 */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 2))
}

describe('writePrices', () => {
  it('keeps independently checked sportsbook offers at bounded intervals, including withdrawals', async () => {
    const db = freshDb() as any
    const quote = { selectionId: 1, bookmakerId: 1, price: 1.9123, historySource: 'native', observedAt: '2026-08-06T23:25:00.000Z' }
    const confirm = (when: string, available = true) => writePrices(db, [{ ...quote, available }], `2026-08-06T${when}Z`)
    const board = (when: string) => historicalBoard(db, { at: `2026-08-06T${when}Z`, sportSlug: 'nfl', limit: 10, maxAgeMinutes: 5 })

    await confirm('23:30:00.010')
    await confirm('23:32:00.000')
    await confirm('23:35:00.020')
    expect(countSnapshots(db)).toBe(1)
    expect(await db.query('SELECT COUNT(*) AS n FROM sportsbook_quote_observations').get()).toEqual({ n: 2 })
    expect((await board('23:36:00.000'))[0]).toMatchObject({ price: 1.9123, source: 'native', capturedAt: '2026-08-06T23:35:00.020Z' })
    expect(await board('23:30:00.000')).toEqual([])
    expect(await board('23:41:00.000')).toEqual([])

    await confirm('23:37:00.030', false)
    expect(await board('23:39:00.000')).toEqual([])
    await confirm('23:38:00.040')
    expect((await board('23:39:00.000'))[0]?.capturedAt).toBe('2026-08-06T23:38:00.040Z')
  })

  it('records the first quote as an opening price', async () => {
    const db = freshDb()

    const result = await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1.91 },
    ])

    expect(result.written).toBe(1)
    expect(result.changed).toBe(1)
    expect(result.snapshots).toBe(1)

    const snapshot = db.query('SELECT price, is_opening FROM odds_snapshots').get() as { price: number, is_opening: number }
    expect(snapshot.price).toBeCloseTo(1.91, 5)
    expect(snapshot.is_opening).toBe(1)
  })

  it('adds no history when the price has not moved', async () => {
    const db = freshDb()

    await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.91 }])
    const afterFirst = countSnapshots(db)
    await tick()

    // The same board, polled again a second later.
    const second = await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.91 }])

    expect(second.written).toBe(1)
    expect(second.changed).toBe(0)
    expect(second.snapshots).toBe(0)
    expect(countSnapshots(db)).toBe(afterFirst)
  })

  it('compares prices at the two decimals the columns store', async () => {
    const db = freshDb()

    // An exchange quotes 1 / 0.62 = 1.6129. Production stores 1.61, so a
    // finer comparison called every pass a move and snapshotted it.
    await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.6129 }])
    await tick()
    const again = await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.6122, point: null }])

    expect(again.changed).toBe(0)
    expect(countSnapshots(db)).toBe(1)
    expect((db.query('SELECT price FROM odds').get() as { price: number }).price).toBeCloseTo(1.61, 5)
  })

  it('appends history when the price moves', async () => {
    const db = freshDb()

    await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.91 }])
    await tick()
    const moved = await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 2.05 }])

    expect(moved.changed).toBe(1)
    expect(moved.snapshots).toBe(1)
    expect(countSnapshots(db)).toBe(2)

    // The current row carries the new price, not both.
    const current = db.query('SELECT price FROM odds WHERE selection_id = 1 AND bookmaker_id = 1').get() as { price: number }
    expect(current.price).toBeCloseTo(2.05, 5)
  })

  it('treats a moved handicap as a move even at the same price', async () => {
    const db = freshDb()

    await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.91, point: -3.5 }])
    await tick()
    const moved = await writePrices(db as any, [{ selectionId: 1, bookmakerId: 1, price: 1.91, point: -2.5 }])

    expect(moved.changed).toBe(1)
    expect(countSnapshots(db)).toBe(2)
  })

  it('survives the same selection and book arriving twice in one batch', async () => {
    const db = freshDb()

    // A duplicate conflict key inside one multi-row statement is what
    // SQLite and Postgres refuse. The later quote is the one that counts.
    const result = await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1.91 },
      { selectionId: 1, bookmakerId: 1, price: 1.95 },
    ])

    expect(result.written).toBe(1)
    const current = db.query('SELECT price FROM odds WHERE selection_id = 1 AND bookmaker_id = 1').get() as { price: number }
    expect(current.price).toBeCloseTo(1.95, 5)
  })

  it('writes many selections and books in one call', async () => {
    const db = freshDb()

    const result = await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1.91 },
      { selectionId: 2, bookmakerId: 1, price: 2.01 },
      { selectionId: 1, bookmakerId: 2, price: 1.88 },
      { selectionId: 2, bookmakerId: 2, price: 2.06 },
    ])

    expect(result.written).toBe(4)
    expect(result.snapshots).toBe(4)

    const rows = (db.query('SELECT COUNT(*) AS n FROM odds').get() as { n: number }).n
    expect(rows).toBe(4)
  })

  it('moves one book without touching the other', async () => {
    const db = freshDb()

    await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1.91 },
      { selectionId: 1, bookmakerId: 2, price: 1.88 },
    ])
    await tick()

    // Only Pinnacle moves. DraftKings re-quoting the same number must not
    // read as a movement — the prior lookup is keyed on the pair, and
    // getting that wrong would mark every book as moving whenever any did.
    const second = await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1.95 },
      { selectionId: 1, bookmakerId: 2, price: 1.88 },
    ])

    expect(second.changed).toBe(1)
    expect(second.snapshots).toBe(1)
    expect(countSnapshots(db)).toBe(3)
  })

  it('refuses a price that cannot be odds', async () => {
    const db = freshDb()

    const result = await writePrices(db as any, [
      { selectionId: 1, bookmakerId: 1, price: 1 },
      { selectionId: 2, bookmakerId: 1, price: Number.NaN },
      { selectionId: 1, bookmakerId: 2, price: 0 },
    ])

    expect(result.written).toBe(0)
    expect(countSnapshots(db)).toBe(0)
  })

  it('does nothing at all with an empty batch', async () => {
    const db = freshDb()
    expect(await writePrices(db as any, [])).toEqual({ written: 0, changed: 0, snapshots: 0 })
  })
})

describe('writeCoverage', () => {
  it('records what a book offers, separately from what it prices', async () => {
    const db = freshDb()

    await writeCoverage(db as any, [
      { bookmakerId: 1, marketEventId: 1, marketType: 'h2h' },
      { bookmakerId: 1, marketEventId: 1, marketType: 'totals' },
    ])

    const rows = db.query('SELECT market_type, line_count FROM book_market_coverage ORDER BY market_type').all() as Array<{ market_type: string, line_count: number }>
    expect(rows.map(r => r.market_type)).toEqual(['h2h', 'totals'])
  })

  it('counts distinct lines rather than inserting a row each', async () => {
    const db = freshDb()

    // A book quoting an alternate ladder: same market type, many lines.
    await writeCoverage(db as any, [
      { bookmakerId: 1, marketEventId: 1, marketType: 'totals' },
      { bookmakerId: 1, marketEventId: 1, marketType: 'totals' },
      { bookmakerId: 1, marketEventId: 1, marketType: 'totals' },
    ])

    const row = db.query('SELECT line_count FROM book_market_coverage').get() as { line_count: number }
    expect(row.line_count).toBe(3)
  })

  it('is idempotent across passes', async () => {
    const db = freshDb()
    const entry = [{ bookmakerId: 1, marketEventId: 1, marketType: 'h2h' }]

    await writeCoverage(db as any, entry)
    await writeCoverage(db as any, entry)

    const count = (db.query('SELECT COUNT(*) AS n FROM book_market_coverage').get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('keeps two books apart on the same market', async () => {
    const db = freshDb()

    await writeCoverage(db as any, [
      { bookmakerId: 1, marketEventId: 1, marketType: 'h2h' },
      { bookmakerId: 2, marketEventId: 1, marketType: 'h2h' },
    ])

    const count = (db.query('SELECT COUNT(*) AS n FROM book_market_coverage').get() as { n: number }).n
    expect(count).toBe(2)
  })

  it('does nothing with an empty batch', async () => {
    const db = freshDb()
    expect(await writeCoverage(db as any, [])).toBe(0)
  })
})
