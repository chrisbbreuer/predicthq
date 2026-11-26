import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { runScheduler, Schedule } from '@stacksjs/scheduler'

/**
 * One scheduler at a time, across releases.
 *
 * Deploys are zero-downtime: the new release starts beside the old one and
 * takes over only once it is healthy. That is right for the socket server
 * and wrong for the scheduler, where two instances would fire every job
 * twice for the length of the overlap. So the socket server starts at once,
 * and the scheduler waits for this lock, which the old release lets go of
 * as it stops. The worker owns the file in storage shared by every release.
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

let running: ReturnType<typeof runScheduler> | undefined
let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping)
    return

  stopping = true
  log.info(`[scheduler] ${signal} received; draining scheduled jobs`)
  try {
    if (running) {
      await running.catch(() => {})
      await Schedule.gracefulShutdown()
    }
  }
  finally {
    releaseSchedulerLock()
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('disconnect', () => void shutdown('IPC disconnect'))

await acquireSchedulerLock()
try {
  running = runScheduler()
  await running
  log.info(`[scheduler] running in worker pid ${process.pid}`)
}
catch (error) {
  releaseSchedulerLock()
  throw error
}
