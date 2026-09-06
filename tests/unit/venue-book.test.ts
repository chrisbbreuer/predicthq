/**
 * The portfolio page's two halves: mirroring what a venue holds, and
 * merging that with the book we kept ourselves.
 *
 * Both exist because our own records are deliberately partial. Positions
 * accrue from fills on orders we placed, which is the only basis a risk
 * limit may use and is silent about a user who also trades by hand. The
 * page has to show both without ever letting the second be mistaken for
 * the first — a simulated or hand-placed holding presented as one this
 * application opened and can settle is the failure worth testing for.
 *
 * The venue is a stub whose answers each test writes: every branch here
 * is about what a venue said, and a test that cannot make a venue say
 * something tests nothing.
 */

import type { BookRow, MirrorRow } from '../../app/Actions/Trading/GetPositions'
import type { VenueMarket } from '../../app/Services/prediction-markets/provider'
import type {
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingClient,
  VenueBalance,
  VenueOrder,
  VenuePosition,
} from '../../app/Services/trading/venue'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mergeHoldings } from '../../app/Actions/Trading/GetPositions'
import { syncAccounts } from '../../app/Services/trading/account-sync'
import { VenueError } from '../../app/Services/trading/venue'
import { schemaFor } from '../support/schema'

const TABLES = [
  'exchange_accounts',
  'prediction_markets',
  'venue_positions',
  'venue_orders',
]

let dir: string
let db: Database

/** A venue that answers exactly what a test tells it to. */
class StubVenue implements TradingClient {
  readonly venue = 'kalshi' as const

  constructor(
    private readonly answers: {
      balance?: number
      positions?: VenuePosition[]
      orders?: VenueOrder[]
      fail?: Error
      failOrders?: Error
    } = {},
  ) {}

  async fetchBalance(): Promise<VenueBalance> {
    if (this.answers.fail)
      throw this.answers.fail
    return { available: this.answers.balance ?? 0 }
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    return this.answers.positions ?? []
  }

  async fetchOpenOrders(): Promise<VenueOrder[]> {
    if (this.answers.failOrders)
      throw this.answers.failOrders
    return this.answers.orders ?? []
  }

  async placeOrder(_request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    throw new Error('not used')
  }

  async fetchOrder(): Promise<PlaceOrderResult | null> {
    return null
  }

  async cancelOrder(): Promise<boolean> {
    return true
  }
}

/** One connected account, and one market we already know the name of. */
function seed(): void {
  const now = '2026-09-05 00:00:00'

  db.prepare(`
    INSERT INTO exchange_accounts (
      id, user_id, venue, label, credentials, masked_identifier, status, balance,
      last_error, last_synced_at, created_at, updated_at
    ) VALUES (1, 7, 'kalshi', 'main', 'sealed', 'abcd', 'active', 0, '', '', ?, ?)
  `).run(now, now)

  db.prepare(`
    INSERT INTO prediction_markets (
      id, venue, external_id, question, outcome_label, category, status, result,
      volume, liquidity, last_price, ends_at, created_at, updated_at
    ) VALUES (1, 'kalshi', 'TICKER-A', 'Will it?', 'Yes', 'Politics', 'open', '', 100, 50, 0.6, ?, ?, ?)
  `).run(now, now, now)
}

function sync(venue: TradingClient, markets: VenueMarket[] = []) {
  return syncAccounts(db as any, {
    clientFor: async () => venue,
    marketsFor: async () => markets,
    now: new Date('2026-09-06T12:00:00.000Z'),
  })
}

function mirrored(): any[] {
  return db.prepare('SELECT * FROM venue_positions ORDER BY id').all()
}

function account(): any {
  return db.prepare('SELECT * FROM exchange_accounts WHERE id = 1').get()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-book-'))
  db = schemaFor(join(dir, 'test.sqlite'), TABLES)
  seed()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('mirroring an account', () => {
  it('records what the venue holds, and what it costs to keep resting', async () => {
    const summary = await sync(new StubVenue({
      balance: 42.5,
      positions: [{ marketExternalId: 'TICKER-A', side: 'yes', size: 12, avgPrice: 0.55 }],
      orders: [{
        externalOrderId: 'venue-1',
        marketExternalId: 'TICKER-A',
        side: 'no',
        limitPrice: 0.3,
        size: 20,
        remainingSize: 8,
        placedAt: '2026-09-06 11:00:00',
      }],
    }))

    expect(summary).toMatchObject({ synced: 1, positions: 1, orders: 1, unreachable: 0 })

    const position = mirrored()[0]
    expect(position.market_external_id).toBe('TICKER-A')
    expect(Number(position.size)).toBe(12)
    // The market we already knew is linked, so the page can show the
    // question rather than the ticker.
    expect(Number(position.prediction_market_id)).toBe(1)

    const order = db.prepare('SELECT * FROM venue_orders').get() as any
    expect(order.external_order_id).toBe('venue-1')
    // The remainder, not the original size: the filled part is already a
    // position, and counting it twice doubles the reported exposure.
    expect(Number(order.remaining_size)).toBe(8)

    expect(Number(account().balance)).toBe(42.5)
    expect(account().last_error).toBe('')
  })

  it('drops a position the venue has stopped reporting', async () => {
    await sync(new StubVenue({
      positions: [
        { marketExternalId: 'TICKER-A', side: 'yes', size: 12, avgPrice: 0.55 },
        { marketExternalId: 'TICKER-B', side: 'no', size: 5, avgPrice: 0.4 },
      ],
    }))
    expect(mirrored()).toHaveLength(2)

    // The user closed one at the venue. A mirror that keeps it is a
    // holding the user does not have.
    await sync(new StubVenue({
      positions: [{ marketExternalId: 'TICKER-A', side: 'yes', size: 12, avgPrice: 0.55 }],
    }))

    const rows = mirrored()
    expect(rows).toHaveLength(1)
    expect(rows[0].market_external_id).toBe('TICKER-A')
  })

  it('learns the question behind a ticker it has never seen', async () => {
    await sync(
      new StubVenue({ positions: [{ marketExternalId: 'TICKER-NEW', side: 'yes', size: 3, avgPrice: 0.2 }] }),
      [{
        venue: 'kalshi',
        externalId: 'TICKER-NEW',
        question: 'Will something else?',
        outcomeLabel: 'Yes',
        category: 'Economics',
        status: 'open',
        result: '',
        volume: 10,
        liquidity: 5,
        lastPrice: 0.25,
        endsAt: '2026-09-30 00:00:00',
      }],
    )

    const market = db.prepare('SELECT * FROM prediction_markets WHERE external_id = ?').get('TICKER-NEW') as any
    expect(market.question).toBe('Will something else?')
    expect(Number(mirrored()[0].prediction_market_id)).toBe(Number(market.id))
  })

  it('shows a position it cannot name rather than hiding it', async () => {
    await sync(new StubVenue({
      positions: [{ marketExternalId: 'TICKER-UNKNOWN', side: 'yes', size: 4, avgPrice: 0.5 }],
    }))

    const row = mirrored()[0]
    expect(row.market_external_id).toBe('TICKER-UNKNOWN')
    expect(Number(row.prediction_market_id)).toBe(0)
  })

  it('still records holdings when the resting-order endpoint fails', async () => {
    const summary = await sync(new StubVenue({
      positions: [{ marketExternalId: 'TICKER-A', side: 'yes', size: 9, avgPrice: 0.5 }],
      failOrders: new VenueError('orders unavailable', 'kalshi', 500, true),
    }))

    // Holdings are the point of the pass. Losing them because the list of
    // what is resting beside them was unavailable is the wrong trade.
    expect(summary).toMatchObject({ synced: 1, positions: 1, orders: 0 })
    expect(mirrored()).toHaveLength(1)
  })

  it('revokes an account whose credentials the venue rejects', async () => {
    const summary = await sync(new StubVenue({
      fail: new VenueError('Kalshi says no', 'kalshi', 401, false),
    }))

    expect(summary.unreachable).toBe(1)
    expect(account().status).toBe('revoked')
  })

  it('keeps an account that merely timed out, and says why it is stale', async () => {
    const summary = await sync(new StubVenue({ fail: new Error('connection reset') }))

    expect(summary.unreachable).toBe(1)
    // A timeout is not a bad key: the next pass has to try again.
    expect(account().status).toBe('active')
    expect(account().last_error).toContain('connection reset')
  })
})

describe('merging the venue mirror with our own book', () => {
  it('takes size from the venue and reasoning from us', () => {
    const [holding] = mergeHoldings(
      [bookRow({ size: 10, cost_basis: 5 })],
      [mirrorRow({ size: 14, avg_price: 0.52 })],
    )

    // The venue is the authority on how much is held: our book knows
    // only the fills we watched, and the user bought four more by hand.
    expect(holding.size).toBe(14)
    expect(holding.avgPrice).toBe(0.52)
    expect(holding.source).toBe('both')
    expect(holding.strategies.map(s => s.name)).toEqual(['Launch test'])
  })

  it('never folds a paper position into a real one', () => {
    const holdings = mergeHoldings(
      [bookRow({ strategy_mode: 'paper', exchange_account_id: null, size: 30, cost_basis: 15 })],
      [mirrorRow({ size: 14, avg_price: 0.52 })],
    )

    expect(holdings).toHaveLength(2)
    expect(holdings.map(h => h.source).sort()).toEqual(['paper', 'venue'])
    // The simulated size stays out of the real line entirely.
    expect(holdings.find(h => h.source === 'venue')?.size).toBe(14)
  })

  it('folds two strategies in the same market into one line', () => {
    const [holding] = mergeHoldings(
      [
        bookRow({ trading_strategy_id: 1, strategy_name: 'One', size: 10, cost_basis: 5 }),
        bookRow({ trading_strategy_id: 2, strategy_name: 'Two', size: 6, cost_basis: 3.6 }),
      ],
      [],
    )

    expect(holding.size).toBe(16)
    expect(holding.cost).toBe(8.6)
    // Weighted across both, not either one's own average.
    expect(holding.avgPrice).toBe(0.54)
    expect(holding.strategies).toHaveLength(2)
  })

  it('marks a NO contract at one minus the quoted price', () => {
    const [holding] = mergeHoldings([], [mirrorRow({ side: 'no', size: 10, avg_price: 0.3, last_price: 0.6 })])

    // Markets are quoted on the YES side; the two sides are halves of a
    // dollar. Marking NO at 0.6 would report a loss as a gain.
    expect(holding.mark).toBe(0.4)
    expect(holding.markValue).toBe(4)
    expect(holding.unrealized).toBe(1)
  })

  it('reports no mark at all for a market it has no price for', () => {
    const [holding] = mergeHoldings([], [mirrorRow({ size: 10, avg_price: 0.3, last_price: 0 })])

    // Not break-even: an unmarked position is unknown, and showing it at
    // cost invents a profit of exactly nothing.
    expect(holding.mark).toBe(0)
    expect(holding.markValue).toBe(0)
  })
})

function bookRow(overrides: Partial<BookRow> = {}): BookRow {
  return {
    id: 1,
    trading_strategy_id: 1,
    strategy_name: 'Launch test',
    strategy_mode: 'live',
    exchange_account_id: 1,
    venue: 'kalshi',
    market_external_id: 'TICKER-A',
    side: 'yes',
    size: 10,
    cost_basis: 5,
    opened_at: '2026-09-05 00:00:00',
    question: 'Will it?',
    outcome_label: 'Yes',
    category: 'Politics',
    market_status: 'open',
    last_price: 0.6,
    ends_at: '2026-09-30 00:00:00',
    ...overrides,
  }
}

function mirrorRow(overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    venue: 'kalshi',
    market_external_id: 'TICKER-A',
    side: 'yes',
    size: 10,
    avg_price: 0.5,
    synced_at: '2026-09-06 12:00:00',
    question: 'Will it?',
    outcome_label: 'Yes',
    category: 'Politics',
    market_status: 'open',
    last_price: 0.6,
    ends_at: '2026-09-30 00:00:00',
    ...overrides,
  }
}
