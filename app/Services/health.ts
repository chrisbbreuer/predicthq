import { Database } from '../Support/db'
import { cache } from '@stacksjs/cache'

/**
 * Whether this process can actually do its job.
 *
 * The endpoint used to answer `{status: 'ok'}` from a literal, which is
 * true of any process able to run JavaScript. A box whose database
 * connection had gone reported itself healthy and a load balancer kept
 * routing to it, which is the precise failure a health check exists to
 * prevent.
 *
 * Two different questions get two different answers, and conflating them
 * is how health checks cause outages:
 *
 *   **Down** — this instance cannot serve. The database is unreachable,
 *   so every request it receives will fail. Answer 503 and let the load
 *   balancer route elsewhere.
 *
 *   **Degraded** — this instance serves fine, but something is wrong
 *   with the system. Ingestion has stalled, the cache is missing. Taking
 *   instances out of rotation for these makes it worse, because the
 *   problem is shared by every instance and removing them removes all of
 *   them. Answer 200, say so in the body, and let the watchdog alert.
 */

/** Beyond this, the data behind every page has stopped being current. */
const STALE_INGEST_MINUTES = 30

export type CheckStatus = 'ok' | 'degraded' | 'down'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  /** Whether this instance can serve at all without it. */
  required: boolean
}

export interface Health {
  status: CheckStatus
  checks: Check[]
  at: string
}

export async function checkHealth(db: Database = new Database()): Promise<Health> {
  const checks = [
    await checkDatabase(db),
    await checkWrites(db),
    await checkCache(),
    await checkIngest(db),
  ]

  const down = checks.some(check => check.required && check.status === 'down')
  const degraded = checks.some(check => check.status !== 'ok')

  return {
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    checks,
    at: new Date().toISOString(),
  }
}

/**
 * The one dependency this process cannot serve a page without.
 *
 * A trivial read rather than a connection-pool statistic: a pool can
 * report healthy sockets to a database that is refusing queries, and it
 * is the query that every request depends on.
 */
async function checkDatabase(db: Database): Promise<Check> {
  try {
    await db.query('SELECT 1').get()
    return { name: 'database', status: 'ok', detail: 'reachable', required: true }
  }
  catch (error) {
    return { name: 'database', status: 'down', detail: message(error), required: true }
  }
}

/**
 * Whether the database accepts writes, not just reads.
 *
 * `SELECT 1` answered happily for months while the production primary was
 * read-only: sign-ins could not store a session, venue syncs could not
 * store a balance, ingestion stopped, and every deploy failed at migrate,
 * all behind a health check that said "reachable". A no-op UPDATE that
 * matches no row is refused by a read-only server before it looks for one,
 * so it detects exactly that state at the cost of an index probe.
 *
 * Degraded rather than down: a read-only primary is shared by every
 * instance, and draining them all would turn read-only pages into none.
 */
async function checkWrites(db: Database): Promise<Check> {
  try {
    await db.prepare('UPDATE ingest_runs SET status = status WHERE id = -1').run()
    return { name: 'database-writes', status: 'ok', detail: 'writable', required: false }
  }
  catch (error) {
    const detail = message(error)
    return {
      name: 'database-writes',
      status: 'degraded',
      detail: /read-only|read only|1290/i.test(detail) ? 'read-only: the primary is refusing writes' : detail.slice(0, 200),
      required: false,
    }
  }
}

/**
 * A round trip, not a ping.
 *
 * Reading back what was just written is the only check that catches a
 * cache accepting writes and returning nothing, which reads as a total
 * miss rate and is otherwise invisible.
 */
async function checkCache(): Promise<Check> {
  const key = 'health:probe'

  try {
    const written = new Date().toISOString()
    await cache.set(key, written, 30)
    const read = await cache.get(key)

    if (read !== written)
      return { name: 'cache', status: 'degraded', detail: 'writes are not readable', required: false }

    return { name: 'cache', status: 'ok', detail: 'round trip', required: false }
  }
  catch (error) {
    return { name: 'cache', status: 'degraded', detail: message(error), required: false }
  }
}

/**
 * Whether the data behind the product is still arriving.
 *
 * Degraded rather than down, deliberately. Stale ingestion is a property
 * of the whole deployment, not of the instance answering, so failing the
 * check here would drain every instance and turn a stale board into no
 * board at all.
 */
async function checkIngest(db: Database): Promise<Check> {
  try {
    // A partial run wrote prices; only some sources failed. For "is data
    // still arriving" that is fresh data, and counting only clean runs
    // reported a board updating every fifteen seconds as stalled whenever
    // one geo-blocked book refused us.
    const row = await db.query<{ last_at: string | null }>(`
      SELECT MAX(finished_at) AS last_at
      FROM ingest_runs
      WHERE status IN ('success', 'partial')
    `).get()

    if (!row?.last_at)
      return { name: 'ingest', status: 'degraded', detail: 'no successful run on record', required: false }

    const ageMinutes = Math.round((Date.now() - Date.parse(row.last_at)) / 60_000)
    if (!Number.isFinite(ageMinutes) || ageMinutes > STALE_INGEST_MINUTES)
      return { name: 'ingest', status: 'degraded', detail: `last succeeded ${ageMinutes} minutes ago`, required: false }

    return { name: 'ingest', status: 'ok', detail: `last succeeded ${ageMinutes} minutes ago`, required: false }
  }
  catch (error) {
    // The ingest table being unreadable while `SELECT 1` succeeds is a
    // schema problem, not a connectivity one, so it does not take the
    // instance out of rotation.
    return { name: 'ingest', status: 'degraded', detail: message(error), required: false }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
