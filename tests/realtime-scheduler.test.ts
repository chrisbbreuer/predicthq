import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for the realtime test fixture')
    await Bun.sleep(20)
  }
}

const entry = new URL('../app/Runtimes/RealtimeScheduler.ts', import.meta.url).href
const realtime = new URL('../app/Support/realtime.ts', import.meta.url).href

test('realtime answers during a blocked scheduler tick and broadcasts when it completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'predicthq-realtime-'))
  const worker = join(dir, 'worker.ts')
  const start = join(dir, 'start')
  const blocked = join(dir, 'blocked')
  const finished = join(dir, 'finished')
  await writeFile(worker, `
    import { publishRealtime } from ${JSON.stringify(realtime)}
    while (!await Bun.file(${JSON.stringify(start)}).exists()) await Bun.sleep(20)
    await Bun.write(${JSON.stringify(blocked)}, '')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500)
    await Bun.write(${JSON.stringify(finished)}, '')
    await publishRealtime('odds', 'board:updated', { fixture: true })
    await Bun.sleep(10_000)
  `)

  const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = reservation.port
  reservation.stop()
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', `import { startRealtimeScheduler } from ${JSON.stringify(entry)}; await startRealtimeScheduler(${JSON.stringify(worker)})`], {
    env: { ...process.env, BROADCAST_HOST: '127.0.0.1', BROADCAST_PORT: String(port) },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  let ws: WebSocket | undefined
  try {
    const url = `http://127.0.0.1:${port}/health`
    await until(() => fetch(url, { signal: AbortSignal.timeout(250) }).then(res => res.ok, () => false))

    const messages: Record<string, unknown>[] = []
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.onopen = () => ws!.send(JSON.stringify({ event: 'subscribe', channel: 'odds' }))
    ws.onmessage = event => messages.push(JSON.parse(event.data))
    await until(() => messages.some(message => message.event === 'subscription_succeeded'))
    await writeFile(start, '')
    await until(() => Bun.file(blocked).exists())

    expect((await fetch(url, { signal: AbortSignal.timeout(600) })).status).toBe(200)
    expect(await Bun.file(finished).exists()).toBe(false)
    await until(() => messages.some(message => message.event === 'board:updated'))
    expect(messages.find(message => message.event === 'board:updated')).toMatchObject({ channel: 'odds', data: { fixture: true } })
  }
  finally {
    ws?.close()
    child.kill()
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 12_000)
