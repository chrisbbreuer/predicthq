import { espnFetch } from '../scores/espn-client'
import type { Database } from '../../Support/db'
import { nowIso } from '../../Support/keys'

/**
 * Provenance for a single ingestion pass.
 *
 * Every pass opens a row before it does any work and closes it afterwards,
 * whatever the outcome. That ordering matters: a pass that crashes or is
 * killed leaves a `running` row behind, which is how a hung provider
 * becomes visible instead of just looking like a quiet period.
 *
 * The counters are the point. `rowsRead` versus `rowsWritten` is the
 * matching yield, and a yield of zero against thousands of rows read is
 * the exact signature of the failure this schema was built to surface —
 * previously that state was indistinguishable from a slow news day.
 */
export class IngestRunTracker {
  private id: number | null = null
  private readonly startedAtMs = Date.now()

  requestCount = 0
  rowsRead = 0
  rowsWritten = 0
  unmatchedCount = 0
  quotaRemaining = -1
  quotaUsed = -1

  private readonly errors: string[] = []

  constructor(
    private readonly db: Database,
    private readonly provider: string,
    private readonly kind: string,
  ) {}

  /** Open the row. Safe to skip calling — `finish` tolerates a missing id. */
  async start(): Promise<void> {
    const res = await this.db
      .prepare(`INSERT INTO ingest_runs (provider, kind, status, started_at, created_at) VALUES (?, ?, 'running', ?, ?)`)
      .run(this.provider, this.kind, nowIso(), nowIso())
    this.id = Number(res.lastInsertRowid)
  }

  /**
   * Record a non-fatal failure. A pass over ten leagues where two time out
   * is a `partial`, not a failure, and the distinction is what stops an
   * on-call alert from firing on every transient upstream blip.
   */
  fail(message: string): void {
    this.errors.push(message.slice(0, 300))
  }

  /**
   * Read the paid feed's remaining budget from its response headers.
   *
   * Quota exhaustion degrades coverage silently — books simply stop
   * appearing — so it is tracked as a first-class number rather than
   * discovered when someone notices a thin board.
   */
  readQuota(headers: Headers): void {
    const remaining = Number(headers.get('x-requests-remaining'))
    const used = Number(headers.get('x-requests-used'))
    if (Number.isFinite(remaining))
      this.quotaRemaining = remaining
    if (Number.isFinite(used))
      this.quotaUsed = used
  }

  /** Close the row with a computed status and a human summary. */
  async finish(summary = ''): Promise<{ status: string, rowsWritten: number, errors: string[] }> {
    const status = this.errors.length === 0
      ? 'success'
      : (this.rowsWritten > 0 ? 'partial' : 'failed')

    if (this.id !== null) {
      await this.db.prepare(`
        UPDATE ingest_runs SET
          status = ?, finished_at = ?, duration_ms = ?,
          request_count = ?, rows_read = ?, rows_written = ?, unmatched_count = ?,
          quota_remaining = ?, quota_used = ?, error = ?, summary = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status,
        nowIso(),
        Date.now() - this.startedAtMs,
        this.requestCount,
        this.rowsRead,
        this.rowsWritten,
        this.unmatchedCount,
        this.quotaRemaining,
        this.quotaUsed,
        this.errors.join(' | ').slice(0, 1000),
        summary.slice(0, 500),
        nowIso(),
        this.id,
      )
    }

    return { status, rowsWritten: this.rowsWritten, errors: this.errors }
  }
}

/**
 * GET a JSON URL with a hard timeout and bounded retries.
 *
 * Retries only on transport failures and 5xx/429 — a 4xx means the request
 * was wrong and repeating it wastes quota against a paid feed without any
 * prospect of a different answer. Backoff is exponential so a provider
 * having a bad minute is not hammered by a scheduler that fires every
 * minute regardless.
 */
export async function fetchWithRetry(
  url: string,
  options: { timeoutMs?: number, retries?: number, headers?: Record<string, string> } = {},
): Promise<Response | null> {
  if (new URL(url).hostname === 'site.web.api.espn.com') {
    let ttlMs = /\/(teams|standings)(?:\?|$)/.test(url) ? 30 * 60_000 : /\/injuries(?:\?|$)/.test(url) ? 5 * 60_000 : 30_000
    const dates = new URL(url).searchParams.get('dates')
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '')
    if (dates && /^\d{8}$/.test(dates) && dates !== today)
      ttlMs = 30 * 60_000
    return espnFetch(url, { ttlMs, timeoutMs: options.timeoutMs })
  }
  const { timeoutMs = 12_000, retries = 2, headers } = options

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (res.ok)
        return res

      // Client errors are permanent for this request; stop immediately.
      if (res.status < 500 && res.status !== 429)
        return res

      if (attempt === retries)
        return res
    }
    catch {
      if (attempt === retries)
        return null
    }

    await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 500))
  }

  return null
}
