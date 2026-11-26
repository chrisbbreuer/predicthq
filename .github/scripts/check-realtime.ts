import process from 'node:process'

const origin = 'https://predicthq.org'
const healthUrl = 'https://realtime.predicthq.org/health'
const socketUrl = 'wss://realtime.predicthq.org/ws'

interface CurlMetrics {
  http_code: number
  http_version: string
  remote_ip: string
  errormsg: string | null
  time_namelookup: number
  time_connect: number
  time_appconnect: number
  time_pretransfer: number
  time_starttransfer: number
  time_total: number
}

interface BoardUpdate {
  at: string
  ageMs: number
  markets: number
}

interface WebSocketResult {
  ok: boolean
  url: string
  error: string | null
  connectedMs: number | null
  subscribedMs: number | null
  elapsedMs: number
  update: BoardUpdate | null
}

function milliseconds(seconds: number): number {
  return Math.round(Math.max(seconds, 0) * 1000 * 100) / 100
}

async function checkHttp() {
  const curl = Bun.spawn([
    'curl', '--disable', '--noproxy', '*', '--silent', '--show-error', '--http2',
    '--connect-timeout', '4', '--max-time', '8', '--output', '/dev/null',
    '--write-out', '%{json}', healthUrl,
  ], { stdout: 'pipe', stderr: 'pipe' })
  const [output, stderr, exitCode] = await Promise.all([
    new Response(curl.stdout).text(), new Response(curl.stderr).text(), curl.exited,
  ])
  if (!output.trim())
    throw new Error(stderr.trim() || `curl exited ${exitCode} without timing data`)

  const timings: CurlMetrics = JSON.parse(output)
  const {
    time_namelookup: dns, time_connect: tcp, time_appconnect: tls,
    time_pretransfer: ready, time_starttransfer: firstByte, time_total: total,
  } = timings
  // curl reports cumulative times and leaves unfinished milestones at zero.
  const phases = [
    { name: 'dns', at: dns },
    { name: 'tcp', at: tcp },
    { name: 'tls', at: tls },
    { name: 'request', at: ready },
    { name: 'first-byte', at: firstByte },
  ]
  const completedPhase = phases.findLastIndex(phase => phase.at > 0)
  const timeoutPhase = exitCode === 28 ? phases[completedPhase + 1]?.name ?? 'response-body' : null
  const ok = exitCode === 0 && timings.http_code === 200 && timings.http_version === '2'
  return {
    ok,
    url: healthUrl,
    exitCode,
    error: timings.errormsg || stderr.trim() || null,
    status: timings.http_code,
    protocol: timings.http_version,
    remoteIp: timings.remote_ip || null,
    lastCompletedPhase: phases[completedPhase]?.name ?? null,
    timeoutPhase,
    timingsMs: {
      dns: dns > 0 ? milliseconds(dns) : null,
      tcp: tcp > 0 ? milliseconds(tcp - dns) : null,
      tls: tls > 0 ? milliseconds(tls - tcp) : null,
      responseWait: firstByte > 0 ? milliseconds(firstByte - ready) : null,
      firstByte: firstByte > 0 ? milliseconds(firstByte) : null,
      total: milliseconds(total),
    },
    exceededTwoSeconds: total >= 2,
  }
}

function checkWebSocket(): Promise<WebSocketResult> {
  const startedAt = performance.now()
  const socket = new WebSocket(socketUrl, { headers: { Origin: origin } })
  const elapsed = () => Math.round(performance.now() - startedAt)
  let connectedMs: number | null = null
  let subscribedMs: number | null = null
  let subscribedAt = 0

  return new Promise((resolve) => {
    let timer = setTimeout(() => finish(connectedMs === null
      ? 'WebSocket connection timed out'
      : 'WebSocket odds subscription timed out'), 10_000)

    function finish(error: string | null, update?: BoardUpdate) {
      clearTimeout(timer)
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.onopen = null
      socket.close()
      resolve({
        ok: error === null,
        url: socketUrl,
        error,
        connectedMs,
        subscribedMs,
        elapsedMs: elapsed(),
        update: update ?? null,
      })
    }

    socket.onopen = () => {
      connectedMs = elapsed()
      socket.send(JSON.stringify({ event: 'subscribe', channel: 'odds' }))
    }
    socket.onerror = () => finish('WebSocket transport error')
    socket.onclose = event => finish(`WebSocket closed early with code ${event.code}`)
    socket.onmessage = ({ data }) => {
      if (typeof data !== 'string')
        return
      let message: { event?: string, channel?: string, data?: { at?: string, events?: unknown[] } }
      try {
        message = JSON.parse(data)
      }
      catch {
        return
      }
      if (message?.channel !== 'odds')
        return
      if (message.event === 'subscription_succeeded' && subscribedMs === null) {
        subscribedMs = elapsed()
        subscribedAt = Date.now()
        clearTimeout(timer)
        // The board is broadcast every minute, with headroom for slow scheduled jobs.
        timer = setTimeout(() => finish('WebSocket odds update missing after 120 seconds'), 120_000)
      }
      const board = message.data
      if (message.event !== 'board:updated' || subscribedMs === null || !board?.at || !Array.isArray(board.events))
        return
      const updatedAt = Date.parse(board.at)
      const ageMs = Date.now() - updatedAt
      if (!Number.isFinite(ageMs) || updatedAt < subscribedAt - 5_000 || ageMs < -5_000 || ageMs > 30_000)
        return
      finish(null, { at: board.at, ageMs, markets: board.events.length })
    }
  })
}

async function record<T extends { ok: boolean }>(probe: () => Promise<T>) {
  try {
    return await probe()
  }
  catch (error) {
    return { ok: false, error: String(error) }
  }
}

const checkedAt = new Date().toISOString()
const [http, websocket] = await Promise.all([record(checkHttp), record(checkWebSocket)])
console.log(JSON.stringify({ checkedAt, http, websocket }, null, 2))
if ('exceededTwoSeconds' in http && http.exceededTwoSeconds)
  console.error('::warning::The HTTP probe exceeded two seconds. See the recorded phase timings.')
if (!http.ok || !websocket.ok)
  process.exitCode = 1
