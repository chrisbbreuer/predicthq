/**
 * Health, the ingestion watchdog, and alert matching.
 *
 * All three are about noticing. Each replaced something that reported
 * success unconditionally, and the failure mode of a check that always
 * passes is that nobody ever looks at it again.
 */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { matches } from '../../app/Services/alerts'
import { checkHealth } from '../../app/Services/health'
import { findStalls } from '../../app/Services/watchdog'
import { schemaFor } from '../support/schema'

const NOW = new Date('2026-08-06T12:00:00.000Z')

let dir: string
let db: Database

/** One completed ingestion pass, `minutesAgo` ago. */
function run(provider: string, kind: string, status: string, minutesAgo: number): void {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

  db.prepare(`
    INSERT INTO ingest_runs (provider, kind, status, started_at, finished_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(provider, kind, status, at, at, at, at)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'predicthq-monitoring-'))
  db = schemaFor(join(dir, 'test.sqlite'), ['ingest_runs'])
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the watchdog', () => {
  it('says nothing about a loop that is keeping up', async () => {
    run('theoddsapi', 'odds', 'success', 3)

    expect(await findStalls(db as any, NOW)).toHaveLength(0)
  })

  it('reports a loop that has gone quiet', async () => {
    run('theoddsapi', 'odds', 'success', 120)

    const [stall] = await findStalls(db as any, NOW)

    expect(stall!.provider).toBe('theoddsapi')
    expect(stall!.reason).toContain('120 minutes ago')
  })

  it('judges on the last success, not the last attempt', async () => {
    run('theoddsapi', 'odds', 'success', 300)
    run('theoddsapi', 'odds', 'failed', 1)

    // Failing every minute looks recent and produces no data. Reading
    // recency alone would call this healthy, which is the precise state
    // that used to go unnoticed for days.
    const [stall] = await findStalls(db as any, NOW)
    expect(stall).toBeDefined()
    expect(stall!.status).toBe('failed')
  })

  it('holds a daily loop to a daily cadence', async () => {
    // Six hours is a dead price loop and an ordinary morning for a
    // backfill. One threshold for both would alert on every backfill.
    run('theoddsapi', 'odds', 'success', 360)
    run('espn', 'fundamentals', 'success', 360)

    const stalls = await findStalls(db as any, NOW)

    expect(stalls.map(s => s.provider)).toEqual(['theoddsapi'])
  })

  it('reports a loop that has never completed anything', async () => {
    run('theoddsapi', 'odds', 'running', 1)

    const [stall] = await findStalls(db as any, NOW)

    expect(stall!.ageMinutes).toBeNull()
    expect(stall!.reason).toContain('never')
  })
})

describe('health', () => {
  it('is degraded, not down, when ingestion has stalled', async () => {
    run('theoddsapi', 'odds', 'success', 600)

    const health = await checkHealth(db as any)

    // Draining every instance over stale data would turn a stale board
    // into no board, and the staleness is not this instance's fault.
    expect(health.status).toBe('degraded')
    expect(health.checks.find(c => c.name === 'ingest')!.status).toBe('degraded')
    expect(health.checks.find(c => c.name === 'database')!.status).toBe('ok')
  })

  it('counts a partial run that wrote prices as fresh ingestion', async () => {
    // Health reads the real clock, so place the run a minute before it.
    run('composite', 'odds', 'partial', (NOW.getTime() - Date.now()) / 60_000 + 1)

    const health = await checkHealth(db as any)

    expect(health.checks.find(c => c.name === 'ingest')!.status).toBe('ok')
  })

  it('says so when the database answers reads but refuses writes', async () => {
    const readOnly = {
      query: (sql: string) => ({ get: async () => (sql.includes('ingest_runs') ? { last_at: new Date().toISOString() } : { 1: 1 }) }),
      prepare: () => ({
        run: async () => { throw new Error('The MySQL server is running with the --read-only option so it cannot execute this statement (errno 1290)') },
      }),
    }

    const health = await checkHealth(readOnly as any)

    expect(health.status).toBe('degraded')
    expect(health.checks.find(c => c.name === 'database')!.status).toBe('ok')
    expect(health.checks.find(c => c.name === 'database-writes')).toMatchObject({ status: 'degraded', detail: 'read-only: the primary is refusing writes' })
  })

  it('reports writes as healthy on a writable database', async () => {
    const health = await checkHealth(db as any)
    expect(health.checks.find(c => c.name === 'database-writes')!.status).toBe('ok')
  })

  it('is down when the database cannot answer', async () => {
    const broken = {
      query: () => ({ get: async () => { throw new Error('connection refused') } }),
      prepare: () => ({ get: async () => { throw new Error('connection refused') } }),
    }

    const health = await checkHealth(broken as any)

    expect(health.status).toBe('down')
    expect(health.checks.find(c => c.name === 'database')!.required).toBe(true)
  })
})

describe('alert matching', () => {
  const alert = {
    kind: 'arbitrage',
    league: 'NFL',
    venue: 'kalshi',
    value: 3,
    title: '',
    body: '',
    data: {},
  }

  it('passes an alert that clears the floor', () => {
    expect(matches({ leagues: '', venue: 'both', min_value: 1 }, alert)).toBe(true)
  })

  it('holds back one below it', () => {
    expect(matches({ leagues: '', venue: 'both', min_value: 5 }, alert)).toBe(false)
  })

  it('reads an empty allowlist as every league', () => {
    // The alternative is a filter nobody filled in matching nothing,
    // which looks like a broken subscription rather than a default.
    expect(matches({ leagues: '', venue: 'both', min_value: 0 }, alert)).toBe(true)
  })

  it('respects a league allowlist, case and spacing aside', () => {
    expect(matches({ leagues: 'nba, nfl', venue: 'both', min_value: 0 }, alert)).toBe(true)
    expect(matches({ leagues: 'nba,mlb', venue: 'both', min_value: 0 }, alert)).toBe(false)
  })

  it('respects a venue filter', () => {
    expect(matches({ leagues: '', venue: 'kalshi', min_value: 0 }, alert)).toBe(true)
    expect(matches({ leagues: '', venue: 'polymarket', min_value: 0 }, alert)).toBe(false)
  })

  it('ignores the venue filter for an alert that has no venue', () => {
    expect(matches({ leagues: '', venue: 'kalshi', min_value: 0 }, { ...alert, venue: '' })).toBe(true)
  })
})
