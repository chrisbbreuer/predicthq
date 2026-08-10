import type { Database } from '../../Support/db'
import process from 'node:process'

/**
 * The global stop.
 *
 * Every risk control in this directory is per strategy: one user's
 * bankroll, one user's loss limit, one user's position cap. None of them
 * answer the question that matters when something is wrong with the
 * system rather than with a strategy — a venue quoting nonsense, an
 * ingestion bug that has poisoned fair value, a deploy that should go out
 * with nothing in flight. The answer has to be "no orders from anyone,
 * now", and it has to take effect without waiting for anybody's next
 * scheduled pass.
 *
 * Two independent switches, and either one is enough to stop trading:
 *
 *   The environment — `TRADING_ENABLED=false`. Deployment-level, and
 *   deliberately not clearable from inside the application. A production
 *   incident should not be resolvable by an API call.
 *
 *   The database — an append-only halt log, so the switch can be thrown
 *   from a CLI in seconds and every process sees it on its next pass
 *   without a redeploy.
 */

export interface HaltState {
  halted: boolean
  reason: string
  actor: string
  since: string
}

const ALLOWED = { halted: false, reason: '', actor: '', since: '' } as const

/**
 * Whether trading is stopped, and why.
 *
 * Read on every execution pass rather than cached: a kill switch that
 * takes effect at the next restart is not a kill switch.
 */
export async function haltState(db: Database): Promise<HaltState> {
  const configured = process.env.TRADING_ENABLED
  if (process.env.APP_ENV === 'production' && configured === undefined) {
    return {
      halted: true,
      reason: 'trading is disabled because production has no explicit TRADING_ENABLED=true',
      actor: 'environment',
      since: '',
    }
  }

  if (configured !== undefined && !truthy(configured)) {
    return {
      halted: true,
      reason: 'trading is disabled for this deployment (TRADING_ENABLED)',
      actor: 'environment',
      since: '',
    }
  }

  const latest = await db.prepare<{ active: number, reason: string, actor: string, created_at: string }>(
    'SELECT active, reason, actor, created_at FROM trading_halts ORDER BY id DESC LIMIT 1',
  ).get()

  if (!latest || !Number(latest.active))
    return { ...ALLOWED }

  return {
    halted: true,
    reason: latest.reason || 'trading is halted',
    actor: latest.actor || 'operator',
    since: latest.created_at ?? '',
  }
}

/**
 * Throw the switch, one way or the other.
 *
 * Writes a row rather than updating one: the history of when trading
 * stopped and started is the record anyone investigating a gap in the
 * order log needs, and an in-place flag would have thrown it away.
 */
export async function setHalt(
  db: Database,
  options: { halted: boolean, reason: string, actor: string },
): Promise<void> {
  const now = new Date().toISOString()

  await db.prepare(
    'INSERT INTO trading_halts (active, reason, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(options.halted ? 1 : 0, options.reason.slice(0, 300), options.actor.slice(0, 120), now, now)
}

/** Env flags are strings; treat the obvious negatives as off. */
function truthy(value: string): boolean {
  return !['0', 'false', 'no', 'off', ''].includes(value.trim().toLowerCase())
}
