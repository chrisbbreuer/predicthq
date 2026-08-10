/**
 * Order reconciliation, position accrual, settlement, and performance.
 *
 * The path money actually travels: an order is placed, a venue fills some
 * or all of it, that becomes a position, the market resolves, and the
 * position becomes a number. Every one of those steps was untested and
 * three of them were wrong.
 *
 * The venue is a stub whose answers each test writes, because every
 * branch under test is about what a venue said, and a test that cannot
 * make a venue say something tests nothing.
 */

import type { PlaceOrderRequest, PlaceOrderResult, TradingClient, VenueBalance, VenuePosition } from '../../app/Services/trading/venue'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { strategyPerformance } from '../../app/Services/trading/performance'
import { openExposure, openPositionCount, realizedPnlSince, settlePositions } from '../../app/Services/trading/positions'
import { syncOrders } from '../../app/Services/trading/sync'
import { schemaFor } from '../support/schema'

const TABLES = [
  'exchange_orders',
  'exchange_accounts',
  'exchange_positions',
  'trade_decisions',
  'trading_strategies',
  'prediction_markets',
]

let dir: string
let db: Database

/** A venue that answers exactly what a test tells it to. */
class StubVenue implements TradingClient {
  readonly venue = 'kalshi' as const
  readonly supportsIdempotentReplay: boolean

  placed: PlaceOrderRequest[] = []
  cancelled: string[] = []

  constructor(
    private readonly onFetch: (id: string) => PlaceOrderResult | null,
    private readonly onPlace: (request: PlaceOrderRequest) => PlaceOrderResult = () => ({
      externalOrderId: 'venue-recovered',
      status: 'open',
      filledSize: 0,
      avgFillPrice: 0,
    }),
    supportsIdempotentReplay = true,
  ) {
    this.supportsIdempotentReplay = supportsIdempotentReplay
  }

  async fetchBalance(): Promise<VenueBalance> {
    return { available: 1000 }
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    return []
  }

  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    this.placed.push(request)
    return this.onPlace(request)
  }

  async fetchOrder(externalOrderId: string): Promise<PlaceOrderResult | null> {
    return this.onFetch(externalOrderId)
  }

  async cancelOrder(externalOrderId: string): Promise<boolean> {
    this.cancelled.push(externalOrderId)
    return true
  }
}

function sync(venue: TradingClient, now?: Date) {
  return syncOrders(db as any, { now, clientFor: async () => venue })
}

/** One strategy, one account, one market, one approved decision. */
function seed(): void {
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO trading_strategies (
      id, user_id, name, venue, mode, categories, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, auto_execute, status, halted_reason, last_run_at,
      created_at, updated_at
    ) VALUES (1, 1, 'Test', 'kalshi', 'live', '', 1000, 100, 0.04, 0.6, 10, 250, 1, 'active', '', '', ?, ?)
  `).run(now, now)

  db.prepare(`
    INSERT INTO exchange_accounts (
      id, user_id, venue, label, credentials, masked_identifier, status, balance,
      last_error, last_synced_at, created_at, updated_at
    ) VALUES (1, 1, 'kalshi', 'main', 'sealed', 'abc', 'active', 1000, '', '', ?, ?)
  `).run(now, now)

  db.prepare(`
    INSERT INTO prediction_markets (
      id, venue, external_id, question, outcome_label, category, status, result,
      volume, liquidity, last_price, ends_at, created_at, updated_at
    ) VALUES (1, 'kalshi', 'TICKER-A', 'Will it?', '', 'Politics', 'open', '', 1000, 500, 0.5, ?, ?, ?)
  `).run(now, now, now)

  db.prepare(`
    INSERT INTO trade_decisions (
      id, trading_strategy_id, prediction_market_id, venue, side, market_price, fair_value,
      edge, confidence, limit_price, size, notional, rationale, decided_by, status,
      status_reason, created_at, updated_at
    ) VALUES (1, 1, 1, 'kalshi', 'yes', 0.5, 0.6, 0.1, 0.8, 0.55, 100, 55, '', 'rules', 'executed', '', ?, ?)
  `).run(now, now)
}

/** An order in flight, placed `minutesAgo` ago. */
function order(options: {
  externalOrderId?: string
  status?: string
  filledSize?: number
  avgFillPrice?: number
  accruedSize?: number
  accruedCost?: number
  minutesAgo?: number
}): number {
  const placedAt = new Date(Date.now() - (options.minutesAgo ?? 0) * 60_000).toISOString()

  const result = db.prepare(`
    INSERT INTO exchange_orders (
      trade_decision_id, exchange_account_id, venue, client_order_id, external_order_id,
      market_external_id, side, limit_price, size, filled_size, avg_fill_price,
      accrued_size, accrued_cost, status, error, placed_at, created_at, updated_at
    ) VALUES (1, 1, 'kalshi', 'client-1', ?, 'TICKER-A', 'yes', 0.55, 100, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(
    options.externalOrderId ?? '',
    options.filledSize ?? 0,
    options.avgFillPrice ?? 0,
    options.accruedSize ?? 0,
    options.accruedCost ?? 0,
    options.status ?? 'pending',
    placedAt,
    placedAt,
    placedAt,
  )

  return Number(result.lastInsertRowid)
}

function readOrder(id: number): any {
  return db.prepare('SELECT * FROM exchange_orders WHERE id = ?').get(id)
}

function positions(): any[] {
  return db.prepare('SELECT * FROM exchange_positions ORDER BY id').all()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-sync-'))
  db = schemaFor(join(dir, 'test.sqlite'), TABLES)
  seed()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reconciliation', () => {
  it('learns the venue id of an order that never recorded one', async () => {
    const id = order({ status: 'pending' })
    const venue = new StubVenue(() => null, () => ({
      externalOrderId: 'venue-7',
      status: 'open',
      filledSize: 0,
      avgFillPrice: 0,
    }))

    const summary = await sync(venue)

    expect(summary.recovered).toBe(1)
    // Replayed under the original client order id, which is what stops
    // the venue treating the replay as a second order.
    expect(venue.placed[0]!.clientOrderId).toBe('client-1')
    expect(readOrder(id).external_order_id).toBe('venue-7')
    expect(readOrder(id).status).toBe('open')
  })

  it('does not replay an uncertain order when the venue has no idempotency key', async () => {
    const id = order({ status: 'pending' })
    const venue = new StubVenue(() => null, undefined, false)

    const summary = await sync(venue)

    expect(summary.recovered).toBe(0)
    expect(venue.placed).toHaveLength(0)
    expect(readOrder(id).status).toBe('uncertain')
    expect((db.prepare('SELECT status FROM trade_decisions WHERE id = 1').get() as any).status).toBe('review')
  })

  it('advances a resting order that has filled, and books the position', async () => {
    const id = order({ status: 'open', externalOrderId: 'venue-7' })
    const venue = new StubVenue(() => ({
      externalOrderId: 'venue-7',
      status: 'filled',
      filledSize: 100,
      avgFillPrice: 0.52,
    }))

    await sync(venue)

    expect(readOrder(id).status).toBe('filled')

    const [position] = positions()
    expect(position.size).toBe(100)
    expect(position.cost_basis).toBeCloseTo(52, 5)
    expect(position.avg_price).toBeCloseTo(0.52, 5)
    expect(position.status).toBe('open')
  })

  it('books a growing partial fill once per increment, not once per pass', async () => {
    order({ status: 'open', externalOrderId: 'venue-7' })

    let filled = 40
    const venue = new StubVenue(() => ({
      externalOrderId: 'venue-7',
      status: 'partial',
      filledSize: filled,
      avgFillPrice: 0.5,
    }))

    await sync(venue)
    expect(positions()[0].size).toBe(40)

    // Same order, more of it filled. Only the difference may be booked.
    filled = 70
    await sync(venue)

    expect(positions()).toHaveLength(1)
    expect(positions()[0].size).toBe(70)
    expect(positions()[0].cost_basis).toBeCloseTo(35, 5)
  })

  it('does not double-book when the venue repeats itself', async () => {
    order({ status: 'partial', externalOrderId: 'venue-7', filledSize: 40, avgFillPrice: 0.5, accruedSize: 40, accruedCost: 20 })

    const venue = new StubVenue(() => ({
      externalOrderId: 'venue-7',
      status: 'partial',
      filledSize: 40,
      avgFillPrice: 0.5,
    }))

    await sync(venue)

    expect(positions()).toHaveLength(0)
  })

  it('cancels an order that has rested past its time to live', async () => {
    const id = order({ status: 'open', externalOrderId: 'venue-7', minutesAgo: 90 })

    // The venue reflects the cancel on the next read, as one does.
    const venue: StubVenue = new StubVenue(() => ({
      externalOrderId: 'venue-7',
      status: venue.cancelled.length > 0 ? 'cancelled' : 'open',
      filledSize: 0,
      avgFillPrice: 0,
    }))

    const summary = await sync(venue)

    expect(summary.expired).toBe(1)
    expect(venue.cancelled).toEqual(['venue-7'])
    expect(readOrder(id).status).toBe('cancelled')
  })

  it('keeps the fill a cancel raced against', async () => {
    const id = order({ status: 'open', externalOrderId: 'venue-7', minutesAgo: 90 })

    // Cancelled, but it crossed on the way. The fill is ours whether we
    // wanted the order by then or not, and dropping it here would leave
    // a position at the venue that our books do not have.
    const venue: StubVenue = new StubVenue(() => venue.cancelled.length > 0
      ? { externalOrderId: 'venue-7', status: 'partial', filledSize: 30, avgFillPrice: 0.5 }
      : { externalOrderId: 'venue-7', status: 'open', filledSize: 0, avgFillPrice: 0 })

    await sync(venue)

    expect(readOrder(id).filled_size).toBe(30)
    expect(positions()[0].size).toBe(30)
  })

  it('leaves a young resting order alone', async () => {
    order({ status: 'open', externalOrderId: 'venue-7', minutesAgo: 5 })
    const venue = new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'open', filledSize: 0, avgFillPrice: 0 }))

    const summary = await sync(venue)

    expect(summary.expired).toBe(0)
    expect(venue.cancelled).toHaveLength(0)
  })

  it('frees the market again when an order is cancelled unfilled', async () => {
    order({ status: 'open', externalOrderId: 'venue-7', minutesAgo: 90 })
    const venue = new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'cancelled', filledSize: 0, avgFillPrice: 0 }))

    await sync(venue)

    // The decision was 'executed' because an order went out. With that
    // order gone and nothing filled, it must not stay executed — that is
    // what would stop the strategy ever revisiting this market.
    const decision: any = db.prepare('SELECT status FROM trade_decisions WHERE id = 1').get()
    expect(decision.status).toBe('expired')
  })

  it('closes an order the venue has never heard of', async () => {
    const id = order({ status: 'open', externalOrderId: 'venue-gone' })
    const venue = new StubVenue(() => null)

    await sync(venue)

    expect(readOrder(id).status).toBe('cancelled')
    expect(readOrder(id).error).toContain('no record')
  })

  it('leaves orders on a revoked account untouched', async () => {
    db.prepare('UPDATE exchange_accounts SET status = \'revoked\' WHERE id = 1').run()
    const id = order({ status: 'open', externalOrderId: 'venue-7' })

    const summary = await sync(new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'filled', filledSize: 100, avgFillPrice: 0.5 })))

    expect(summary.unreachable).toBe(1)
    expect(readOrder(id).status).toBe('open')
  })
})

describe('risk from positions', () => {
  it('counts open positions rather than every order ever placed', async () => {
    order({ status: 'open', externalOrderId: 'venue-7' })
    await sync(new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'filled', filledSize: 100, avgFillPrice: 0.5 })))

    expect(await openPositionCount(db as any, 1)).toBe(1)

    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'yes\' WHERE id = 1').run()
    await settlePositions(db as any)

    // Settled money is not exposure. This is the ratchet that stopped
    // strategies trading once they had filled their position cap.
    expect(await openPositionCount(db as any, 1)).toBe(0)
  })

  it('counts a working order once, not twice as it fills', async () => {
    order({ status: 'open', externalOrderId: 'venue-7' })

    // Nothing filled: the whole order is committed.
    expect(await openExposure(db as any, 1)).toBeCloseTo(55, 5)

    await sync(new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'partial', filledSize: 50, avgFillPrice: 0.5 })))

    // Half filled: 25 in the position plus 27.5 still working.
    expect(await openExposure(db as any, 1)).toBeCloseTo(52.5, 5)
  })
})

describe('settlement', () => {
  beforeEach(async () => {
    order({ status: 'open', externalOrderId: 'venue-7' })
    await sync(new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'filled', filledSize: 100, avgFillPrice: 0.4 })))
  })

  it('pays out a winning side at a dollar a contract', async () => {
    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'yes\' WHERE id = 1').run()

    const summary = await settlePositions(db as any)

    expect(summary.settled).toBe(1)
    // 100 contracts bought at 40c, worth a dollar each.
    expect(summary.realized).toBeCloseTo(60, 5)
    expect(positions()[0].status).toBe('settled')
    expect(positions()[0].settlement_price).toBe(1)
  })

  it('writes off a losing side entirely', async () => {
    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'no\' WHERE id = 1').run()

    const summary = await settlePositions(db as any)

    expect(summary.realized).toBeCloseTo(-40, 5)
    expect(positions()[0].settlement_price).toBe(0)
  })

  it('settles a position once, however often the pass runs', async () => {
    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'yes\' WHERE id = 1').run()

    await settlePositions(db as any)
    const second = await settlePositions(db as any)

    expect(second.settled).toBe(0)
  })

  it('leaves an unresolved market open', async () => {
    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'\' WHERE id = 1').run()

    expect((await settlePositions(db as any)).settled).toBe(0)
  })
})

describe('the daily loss limit', () => {
  it('reads a loss, and ignores a profit', async () => {
    order({ status: 'open', externalOrderId: 'venue-7' })
    await sync(new StubVenue(() => ({ externalOrderId: 'venue-7', status: 'filled', filledSize: 100, avgFillPrice: 0.4 })))

    db.prepare('UPDATE prediction_markets SET status = \'settled\', result = \'no\' WHERE id = 1').run()
    await settlePositions(db as any)

    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    // The old measure summed what filled orders cost and called it loss,
    // which reported this as -40 whether the position won or lost.
    expect(await realizedPnlSince(db as any, 1, startOfDay)).toBeCloseTo(-40, 5)
  })
})

describe('performance', () => {
  it('reports hit rate, return, and drawdown from settled positions', async () => {
    const now = new Date().toISOString()
    const insert = db.prepare(`
      INSERT INTO exchange_positions (
        trading_strategy_id, exchange_account_id, prediction_market_id, venue,
        market_external_id, side, size, cost_basis, avg_price, realized_pnl,
        status, settlement_price, opened_at, settled_at, created_at, updated_at
      ) VALUES (1, 1, 1, 'kalshi', ?, 'yes', 100, ?, 0.5, ?, 'settled', ?, ?, ?, ?, ?)
    `)

    // +50, then -80, then +30: peak 50, trough -30, so a 80 drawdown.
    insert.run('A', 50, 50, 1, now, '2026-01-01T00:00:00.000Z', now, now)
    insert.run('B', 80, -80, 0, now, '2026-01-02T00:00:00.000Z', now, now)
    insert.run('C', 20, 30, 1, now, '2026-01-03T00:00:00.000Z', now, now)

    const performance = await strategyPerformance(db as any, 1)

    expect(performance.settled).toBe(3)
    expect(performance.wins).toBe(2)
    expect(performance.hitRate).toBeCloseTo(2 / 3, 3)
    expect(performance.realized).toBeCloseTo(0, 5)
    expect(performance.invested).toBeCloseTo(150, 5)
    expect(performance.roi).toBeCloseTo(0, 5)
    expect(performance.maxDrawdown).toBeCloseTo(80, 5)
    expect(performance.best).toBeCloseTo(50, 5)
    expect(performance.worst).toBeCloseTo(-80, 5)
  })

  it('declines to report a return on nothing', async () => {
    const performance = await strategyPerformance(db as any, 1)

    expect(performance.settled).toBe(0)
    expect(performance.hitRate).toBeNull()
    expect(performance.roi).toBeNull()
  })
})
