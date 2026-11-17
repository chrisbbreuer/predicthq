import type { Database } from '../Support/db'
import { log } from '@stacksjs/logging'
import { useDatabase } from '@stacksjs/notifications'
import { channel } from '@stacksjs/realtime'

/**
 * Noticing when the data stops arriving.
 *
 * Every ingestion pass records what it did, and `/api/v1/status` will
 * report it to anyone who asks — but nothing asked. A provider that
 * stopped matching, a key that expired, a worker that died: all of them
 * look from the outside exactly like a quiet night, and the board keeps
 * serving the last prices it had as though they were current. The product
 * is worth what its data freshness is worth, so a stall has to announce
 * itself rather than wait to be discovered.
 *
 * What counts as overdue depends on the loop. Prices refresh every few
 * minutes and daily fundamentals refresh once a day, so a single
 * threshold would either alert constantly on the slow ones or never on
 * the fast ones.
 */

/** How long each kind of pass may go between successes, in minutes. */
const OVERDUE_AFTER: Record<string, number> = {
  odds: 20,
  schedule: 90,
  fundamentals: 36 * 60,
}

/** Anything not named above. Generous, because guessing low cries wolf. */
const DEFAULT_OVERDUE_MINUTES = 6 * 60

/**
 * How long to stay quiet after alerting on the same loop.
 *
 * A stall lasts until someone fixes it, and a watchdog that repeats every
 * minute for an hour teaches people to filter it out — which is the same
 * as not having one.
 */
const COOLDOWN_MINUTES = 60

export interface Stall {
  provider: string
  kind: string
  status: string
  /** Minutes since this loop last succeeded, or null if it never has. */
  ageMinutes: number | null
  reason: string
}

export interface WatchdogSummary {
  checked: number
  stalls: Stall[]
  alerted: number
}

/**
 * Find every loop that has stopped producing, and announce the new ones.
 */
export async function runWatchdog(db: Database, now: Date = new Date()): Promise<WatchdogSummary> {
  const stalls = [...await findStalls(db, now), ...await findQuietBooks(db, now)]
  let alerted = 0

  for (const stall of stalls) {
    if (await alertedRecently(db, stall, now))
      continue

    await announce(db, stall)
    alerted++
  }

  const checked = await countLoops(db)
  return { checked, stalls, alerted }
}

/**
 * Loops that are overdue or outright failing.
 *
 * Judged on the last *successful* pass rather than the last pass of any
 * kind. A provider failing every minute has a very recent run and no
 * fresh data, and reading recency alone would call that healthy.
 */
export async function findStalls(db: Database, now: Date = new Date()): Promise<Stall[]> {
  const rows = await db.query<{
    provider: string
    kind: string
    status: string
    last_success: string | null
  }>(`
    SELECT
      provider,
      kind,
      (
        SELECT status FROM ingest_runs latest
        WHERE latest.provider = runs.provider AND latest.kind = runs.kind
        ORDER BY latest.id DESC LIMIT 1
      ) AS status,
      MAX(CASE WHEN status IN ('success', 'partial') THEN finished_at END) AS last_success
    FROM ingest_runs runs
    GROUP BY provider, kind
  `).all()

  const stalls: Stall[] = []

  for (const row of rows) {
    const limit = OVERDUE_AFTER[row.kind] ?? DEFAULT_OVERDUE_MINUTES

    if (!row.last_success) {
      stalls.push({
        provider: row.provider,
        kind: row.kind,
        status: row.status ?? 'unknown',
        ageMinutes: null,
        reason: 'has never completed a pass',
      })
      continue
    }

    const ageMinutes = Math.round((now.getTime() - Date.parse(row.last_success)) / 60_000)
    if (!Number.isFinite(ageMinutes) || ageMinutes <= limit)
      continue

    stalls.push({
      provider: row.provider,
      kind: row.kind,
      status: row.status ?? 'unknown',
      ageMinutes,
      reason: `last succeeded ${ageMinutes} minutes ago, and runs every ${limit} at the latest`,
    })
  }

  return stalls
}

/** Books that push prices, and so should never fall silent on a live game. */
const STREAMING_BOOKS = ['kalshi', 'polymarket']

/** Minutes a streaming book may go without updating a live or imminent game. */
const QUIET_AFTER_MINUTES = 15

/**
 * Streaming books that have gone quiet on games that matter right now.
 *
 * `ingest_runs` cannot see this: the stream writes through one shared
 * "stream" run, so one book dying while the other keeps pushing looks
 * healthy there. Judged per book, and only on games from two hours before
 * now to an hour ahead, which a live exchange reprices constantly. A book
 * with no such games is not judged at all, so a quiet night is not an
 * alert.
 */
export async function findQuietBooks(db: Database, now: Date = new Date()): Promise<Stall[]> {
  const from = new Date(now.getTime() - 2 * 3_600_000).toISOString()
  const to = new Date(now.getTime() + 3_600_000).toISOString()
  const rows = await db.query<{ book: string, quotes: number | string, last_update: string | Date | null }>(`
    SELECT b.slug AS book, COUNT(*) AS quotes, MAX(o.updated_at) AS last_update
    FROM odds o
    JOIN bookmakers b ON b.id = o.bookmaker_id
    JOIN selections sel ON sel.id = o.selection_id
    JOIN markets m ON m.id = sel.market_id
    JOIN market_events e ON e.id = m.market_event_id
    WHERE b.slug IN (${STREAMING_BOOKS.map(() => '?').join(', ')})
      AND e.commence_at >= ? AND e.commence_at <= ?
    GROUP BY b.slug
  `).all(...STREAMING_BOOKS, from, to)

  const stalls: Stall[] = []
  for (const row of rows) {
    if (Number(row.quotes) === 0 || !row.last_update)
      continue
    const last = row.last_update instanceof Date ? row.last_update.getTime() : Date.parse(String(row.last_update).replace(' ', 'T') + (String(row.last_update).endsWith('Z') ? '' : 'Z'))
    const ageMinutes = Math.round((now.getTime() - last) / 60_000)
    if (!Number.isFinite(ageMinutes) || ageMinutes <= QUIET_AFTER_MINUTES)
      continue
    stalls.push({
      provider: row.book,
      kind: 'stream',
      status: 'quiet',
      ageMinutes,
      reason: `has not updated a live or imminent game in ${ageMinutes} minutes`,
    })
  }
  return stalls
}

/**
 * Whether this loop has already been announced inside the cooldown.
 *
 * Read from the notifications this watchdog writes rather than from
 * memory, so the quiet period survives a restart — otherwise a crash
 * loop in the worker becomes a notification loop as well.
 */
async function alertedRecently(db: Database, stall: Stall, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - COOLDOWN_MINUTES * 60_000).toISOString()

  const row = await db.query<{ n: number }>(`
    SELECT COUNT(*) AS n FROM notifications
    WHERE type = 'ingest_stalled'
      AND created_at >= ?
      AND data LIKE ?
  `).get(since, `%"loop":"${stall.provider}/${stall.kind}"%`)

  return Number(row?.n ?? 0) > 0
}

/**
 * Record and broadcast one stall.
 *
 * The log line is written first and unconditionally. The notification
 * table and the realtime channel are both best-effort — neither is
 * running in every environment — but a stall that fails to notify and
 * leaves nothing behind is the failure this whole file exists to end.
 */
async function announce(db: Database, stall: Stall): Promise<void> {
  const loop = `${stall.provider}/${stall.kind}`
  log.error(`[watchdog] ${loop} ${stall.reason}`)

  const payload = { loop, provider: stall.provider, kind: stall.kind, status: stall.status, ageMinutes: stall.ageMinutes, reason: stall.reason }

  try {
    const userId = await operatorId(db)
    if (userId === null)
      log.warn('[watchdog] no account to notify of the stall; set WATCHDOG_NOTIFY_EMAIL or create a user')
    else
      await useDatabase().send({ userId, type: 'ingest_stalled', data: payload })
  }
  catch (error) {
    log.warn(`[watchdog] could not record the stall notification: ${message(error)}`)
  }

  try {
    await channel('alerts').broadcast('ingest_stalled', payload)
  }
  catch (error) {
    log.warn(`[watchdog] could not broadcast the stall: ${message(error)}`)
  }
}

/**
 * The account a stall notification belongs to.
 *
 * `notifications.user_id` references `users`, so the row needs a real
 * account; the old `0` was refused by the foreign key on every stall, and
 * with no row written the cooldown above never engaged either. The site
 * has no admin role, so the owner is the first account created, unless
 * `WATCHDOG_NOTIFY_EMAIL` names another.
 */
export async function operatorId(db: Database): Promise<number | null> {
  const email = process.env.WATCHDOG_NOTIFY_EMAIL?.trim()
  const row = email
    ? await db.query<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1').get(email)
    : await db.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1').get()

  return row ? Number(row.id) : null
}

async function countLoops(db: Database): Promise<number> {
  const row = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM (SELECT 1 FROM ingest_runs GROUP BY provider, kind) AS loops',
  ).get()

  return Number(row?.n ?? 0)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
