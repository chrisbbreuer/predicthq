import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

/**
 * Whether `buddy odds:watch` is running, as the scheduler can see it.
 *
 * The scheduler's odds passes (the every-minute `IngestOdds` and the odds
 * stage of `RunPipeline`) are the floor that keeps the board moving when the
 * watcher is down. While it is up they repeat its work at a sixtieth of its
 * cadence: the same books, the same leagues, the same writes. The exchange
 * books made that repeat expensive, since only the watcher holds their
 * sockets and the scheduler polled every league of both instead, holding
 * ~300 MB per pass and running the scheduler out of memory every few minutes.
 *
 * The watcher touches a file and the scheduler skips its passes while the
 * file is fresh. In production it lives outside both sites
 * (`ODDS_WATCH_HEARTBEAT_PATH` in config/cloud.ts): each site's
 * `storage/ingest` is shared across its own releases, not with other sites. A watcher that dies stops touching it, so the floor returns within
 * {@link STALE_MS} without anything having to notice.
 */
const PATH = process.env.ODDS_WATCH_HEARTBEAT_PATH || 'storage/ingest/.odds-watch.heartbeat'

/** How often the watcher touches the file. */
export const BEAT_MS = 15_000

/** How old the file may be before the scheduler stops trusting it. */
export const STALE_MS = 2 * 60_000

export function beat(path = PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(process.pid))
  }
  catch {}
}

/** A watcher shutting down says so, rather than leaving the floor off for two minutes. */
export function clearBeat(path = PATH): void {
  rmSync(path, { force: true })
}

export function watcherLive(now = Date.now(), path = PATH): boolean {
  try {
    return now - statSync(path).mtimeMs < STALE_MS
  }
  catch {
    return false
  }
}
