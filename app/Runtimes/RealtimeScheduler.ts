import type { ServerConfig } from 'ts-broadcasting'
import { log } from '@stacksjs/logging'
import { createServer, stopServer } from '@stacksjs/realtime'
import { runScheduler, Schedule } from '@stacksjs/scheduler'
import realtime from '../../config/realtime'

const server = realtime.server
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
    },
  },
  rateLimit: server.rateLimit,
  loadManagement: server.loadManagement,
  debug: realtime.debug,
}

await createServer(config)
await runScheduler()
log.info(`[realtime] socket and scheduler ready on ${server.host}:${server.port}`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping)
    return

  stopping = true
  log.info(`[realtime] ${signal} received; draining scheduler and sockets`)
  await Schedule.gracefulShutdown()
  await stopServer()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
