import process from 'node:process'
import { channel } from '@stacksjs/realtime'

interface RealtimeBroadcast {
  type: 'predicthq:realtime'
  channel: string
  event: string
  data: unknown
}

export function isRealtimeBroadcast(message: unknown): message is RealtimeBroadcast {
  if (message === null || typeof message !== 'object')
    return false
  const candidate = message as Partial<RealtimeBroadcast>
  return candidate.type === 'predicthq:realtime' && typeof candidate.channel === 'string' && typeof candidate.event === 'string'
}

/** Publish through the local listener, or hand a scheduler broadcast to its parent. */
export async function publishRealtime(name: string, event: string, data: unknown): Promise<void> {
  if (process.env.PREDICTHQ_SCHEDULER_WORKER !== '1')
    return channel(name).public(event, data)

  if (!process.send || !process.connected)
    throw new Error('The realtime listener is disconnected')
  const message: RealtimeBroadcast = { type: 'predicthq:realtime', channel: name, event, data }
  await new Promise<void>((resolve, reject) => {
    process.send!(message, error => error ? reject(error) : resolve())
  })
}
