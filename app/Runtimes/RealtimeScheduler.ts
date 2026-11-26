import type { ServerConfig } from '@stacksjs/realtime'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { log } from '@stacksjs/logging'
import { createServer, stopServer } from '@stacksjs/realtime'
import realtime from '../../config/realtime'
import { isRealtimeBroadcast, publishRealtime } from '../Support/realtime'

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

// Keep the public listener off the event loop that runs ingest and database
// jobs. This process still owns the broadcast server and serves the same API.
export async function startRealtimeScheduler(workerPath = fileURLToPath(new URL('./SchedulerWorker.ts', import.meta.url))): Promise<void> {
  await createServer(config)
  log.info(`[realtime] socket ready on ${server.host}:${server.port}`)

  let stopping = false
  const scheduler = Bun.spawn([process.execPath, workerPath], {
    env: { ...process.env, PREDICTHQ_SCHEDULER_WORKER: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message) {
      if (isRealtimeBroadcast(message)) {
        void publishRealtime(message.channel, message.event, message.data)
          .catch(error => log.warn(`[realtime] could not publish ${message.channel}/${message.event}: ${error}`))
      }
    },
  })

  async function shutdown(code: number): Promise<void> {
    if (stopping)
      return

    stopping = true
    if (scheduler.exitCode === null && scheduler.signalCode === null)
      scheduler.kill('SIGTERM')
    await scheduler.exited
    try {
      await stopServer()
    }
    finally {
      process.exit(code)
    }
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  void scheduler.exited.then((code) => {
    if (!stopping) {
      log.error(`[realtime] scheduler worker exited with code ${code}`)
      void shutdown(1)
    }
  })
}

if (import.meta.main)
  await startRealtimeScheduler()
