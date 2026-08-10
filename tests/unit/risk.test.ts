/**
 * The checks that stand between a decision and a real order.
 *
 * Two of them, both added because their absence was not visible from the
 * outside: an order placed against a quote nobody had refreshed, and no
 * way to stop every strategy at once when the system rather than a
 * strategy is what has gone wrong.
 */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isPaper, quoteObjection } from '../../app/Services/trading/execute'
import { haltState, setHalt } from '../../app/Services/trading/halt'
import { schemaFor } from '../support/schema'

const NOW = '2026-08-06T12:00:00.000Z'

function market(overrides: Partial<{ status: string, last_price: number, updated_at: string }> = {}) {
  return {
    status: 'open',
    last_price: 0.5,
    updated_at: NOW,
    ...overrides,
  }
}

const decision = { market_price: 0.5, limit_price: 0.55 }

describe('the quote check', () => {
  it('passes a fresh quote inside the limit', () => {
    expect(quoteObjection(decision, market(), NOW)).toBe('')
  })

  it('refuses a market that is no longer open', () => {
    expect(quoteObjection(decision, market({ status: 'settled' }), NOW)).toContain('settled')
  })

  it('refuses a quote nobody has refreshed', () => {
    const stale = new Date(Date.parse(NOW) - 30 * 60_000).toISOString()

    expect(quoteObjection(decision, market({ updated_at: stale }), NOW)).toContain('no price')
  })

  it('refuses a market that has moved since the decision', () => {
    // Four points up on a decision reasoned at fifty. The limit would
    // still protect the price paid; what it cannot protect is a fair
    // value derived from tape that predates whatever moved it.
    expect(quoteObjection(decision, market({ last_price: 0.54 }), NOW)).toContain('moved up')
    expect(quoteObjection(decision, market({ last_price: 0.46 }), NOW)).toContain('moved down')
  })

  it('tolerates a move inside the tolerance', () => {
    expect(quoteObjection(decision, market({ last_price: 0.52 }), NOW)).toBe('')
  })

  it('refuses when the market has already reached the limit', () => {
    // Two points is inside the drift tolerance but at the limit, so
    // there is no edge left and the order would only rest.
    expect(quoteObjection({ market_price: 0.54, limit_price: 0.55 }, market({ last_price: 0.55 }), NOW))
      .toContain('against our')
  })
})

describe('paper mode', () => {
  it('simulates only when it is asked to', () => {
    expect(isPaper({ mode: 'paper' })).toBe(true)
    expect(isPaper({ mode: 'live' })).toBe(false)
  })

  it('treats a strategy older than the column as live', () => {
    // The dangerous direction: reading an absent mode as paper would
    // silently stop a live strategy from trading, and it would look
    // like it was working the whole time.
    expect(isPaper({ mode: null })).toBe(false)
  })
})

describe('the global stop', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'predicthq-halt-'))
    db = schemaFor(join(dir, 'test.sqlite'), ['trading_halts'])
    delete process.env.TRADING_ENABLED
    process.env.APP_ENV = 'test'
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.TRADING_ENABLED
    process.env.APP_ENV = 'test'
  })

  it('allows trading when nothing has been said', async () => {
    expect((await haltState(db as any)).halted).toBe(false)
  })

  it('stops on the halt log, and says who and why', async () => {
    await setHalt(db as any, { halted: true, reason: 'venue quoting nonsense', actor: 'chris' })

    const state = await haltState(db as any)

    expect(state.halted).toBe(true)
    expect(state.reason).toBe('venue quoting nonsense')
    expect(state.actor).toBe('chris')
  })

  it('resumes on the newest entry, not the loudest', async () => {
    await setHalt(db as any, { halted: true, reason: 'incident', actor: 'chris' })
    await setHalt(db as any, { halted: false, reason: 'resolved', actor: 'chris' })

    expect((await haltState(db as any)).halted).toBe(false)
  })

  it('keeps the history of both', async () => {
    await setHalt(db as any, { halted: true, reason: 'incident', actor: 'chris' })
    await setHalt(db as any, { halted: false, reason: 'resolved', actor: 'chris' })

    const rows: any[] = db.prepare('SELECT active FROM trading_halts ORDER BY id').all()
    expect(rows.map(r => r.active)).toEqual([1, 0])
  })

  it('lets the environment overrule a cleared halt log', async () => {
    await setHalt(db as any, { halted: false, reason: 'resumed', actor: 'chris' })
    process.env.TRADING_ENABLED = 'false'

    const state = await haltState(db as any)

    expect(state.halted).toBe(true)
    expect(state.actor).toBe('environment')
  })

  it('reads the obvious negatives as off', async () => {
    for (const value of ['false', '0', 'no', 'off']) {
      process.env.TRADING_ENABLED = value
      expect((await haltState(db as any)).halted).toBe(true)
    }

    process.env.TRADING_ENABLED = 'true'
    expect((await haltState(db as any)).halted).toBe(false)
  })

  it('fails closed when production never explicitly enabled trading', async () => {
    process.env.APP_ENV = 'production'
    delete process.env.TRADING_ENABLED

    const state = await haltState(db as any)

    expect(state.halted).toBe(true)
    expect(state.reason).toContain('explicit TRADING_ENABLED=true')
  })
})
