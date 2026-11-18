import type { ServerConfig } from '@stacksjs/realtime'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { createServer, stopServer } from '@stacksjs/realtime'
import { runScheduler, Schedule } from '@stacksjs/scheduler'
import realtime from '../../config/realtime'

const server = realtime.server

/**
 * The configured limit, in ts-broadcasting's terms.
 *
 * `config/realtime.ts` describes it the Stacks way (messages per second per
 * socket), and ts-broadcasting counts `max` messages per `window` ms. This was
 * passed through unconverted, so ts-broadcasting found no `max` or `window`,
 * fell back to its own 100 per minute, and `enabled: false` never turned
 * it off.
 */
const rateLimit: ServerConfig['rateLimit'] = server.rateLimit.enabled
  ? { max: server.rateLimit.maxMessagesPerSecond, window: 1_000 }
  : undefined

const config: ServerConfig = {
  default: 'bun',
  host: server.host,
  port: server.port,
  connections: {
    bun: {
      driver: 'bun',
      host: server.host,
      port: server.port,
      scheme: server.scheme,
      // Share the port with the release being replaced, so a zero-downtime
      // deploy can start this one beside it instead of stopping it first.
      reusePort: true,
    },
  },
  rateLimit,
  loadManagement: server.loadManagement,
  debug: realtime.debug,
}

/**
 * One scheduler at a time, across releases.
 *
 * Deploys are zero-downtime: the new release starts beside the old one and
 * takes over only once it is healthy. That is right for the socket server
 * and wrong for the scheduler, where two instances would fire every job
 * twice for the length of the overlap. So the socket server starts at once,
 * and the scheduler waits for this lock, which the old release lets go of
 * as it stops. The file lives in storage shared by every release.
 */
const LOCK = process.env.SCHEDULER_LOCK_PATH || 'storage/ingest/.scheduler.lock'

/** The live process holding the lock, or null when it is free or stale. */
function lockHolder(): number | null {
  let pid = 0
  try {
    pid = Number(readFileSync(LOCK, 'utf8').trim())
  }
  catch {
    return null
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
    return null
  try {
    process.kill(pid, 0)
    return pid
  }
  catch (error) {
    // EPERM: alive but someone else's. ESRCH: gone, so the lock is stale.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

async function acquireSchedulerLock(): Promise<void> {
  let announced = false
  for (;;) {
    const holder = lockHolder()
    if (holder === null) {
      writeFileSync(LOCK, String(process.pid))
      return
    }
    if (!announced) {
      log.info(`[realtime] socket ready; scheduler waits for the previous release (pid ${holder}) to stop`)
      announced = true
    }
    await Bun.sleep(500)
  }
}

function releaseSchedulerLock(): void {
  try {
    if (readFileSync(LOCK, 'utf8').trim() === String(process.pid))
      unlinkSync(LOCK)
  }
  catch {}
}

let scheduling = false

await createServer(config)
log.info(`[realtime] socket ready on ${server.host}:${server.port}`)
await acquireSchedulerLock()
await runScheduler()
scheduling = true
log.info(`[realtime] scheduler running (pid ${process.pid})`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping)
    return

  stopping = true
  log.info(`[realtime] ${signal} received; draining scheduler and sockets`)
  if (scheduling)
    await Schedule.gracefulShutdown()
  // Let the next release's scheduler start as soon as this one has stopped.
  releaseSchedulerLock()
  await stopServer()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
