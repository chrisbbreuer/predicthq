import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One cache, request budget and refusal cooldown shared by web, watcher and jobs. */
export function createEspnClient(options: {
  path?: string
  fetch?: typeof fetch
  now?: () => number
  budget?: number
} = {}) {
  const store = new Database(options.path ?? process.env.ESPN_CACHE_PATH ?? join(tmpdir(), 'predicthq-espn-cache.sqlite'), { create: true })
  store.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS responses (url TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL, blocked INTEGER NOT NULL);
    INSERT OR IGNORE INTO budget VALUES (1, 0, 0, 0);
    CREATE TABLE IF NOT EXISTS pacing (id INTEGER PRIMARY KEY, next_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO pacing VALUES (1, 0);`)
  const clock = options.now ?? Date.now
  const transport = options.fetch ?? fetch
  const inFlight = new Map<string, Promise<Response | null>>()
  const reserve = store.transaction((now: number) => {
    const state = store.query<{ window: number, used: number, blocked: number }, []>('SELECT * FROM budget WHERE id = 1').get()!
    if (state.blocked > now)
      return null
    const fresh = now - state.window >= 60_000
    if (!fresh && state.used >= (options.budget ?? 180))
      return null
    const pacing = store.query<{ next_at: number }, []>('SELECT next_at FROM pacing WHERE id = 1').get()!
    const at = Math.max(now, pacing.next_at)
    if (at - now > 8000) return null
    store.query('UPDATE pacing SET next_at = ? WHERE id = 1').run(at + 250)
    store.query('UPDATE budget SET window = ?, used = ? WHERE id = 1').run(fresh ? now : state.window, fresh ? 1 : state.used + 1)
    return at - now
  })
  async function load(url: string, ttlMs: number, timeoutMs: number): Promise<Response | null> {
    const now = clock()
    const hit = store.query<{ body: string, expires: number }, [string]>('SELECT body, expires FROM responses WHERE url = ?').get(url)
    if (hit && hit.expires > now)
      return new Response(hit.body, { headers: { 'content-type': 'application/json' } })
    const delay = reserve.immediate(now)
    if (delay === null)
      return null
    if (delay > 0)
      await new Promise(resolve => setTimeout(resolve, delay))
    const state = store.query<{ blocked: number }, []>('SELECT blocked FROM budget WHERE id = 1').get()!
    if (state.blocked > clock()) return null
    try {
      const res = await transport(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 403 || res.status === 429) {
        const retry = res.headers.get('retry-after')
        const seconds = retry === null ? Number.NaN : Number(retry)
        const until = Number.isFinite(seconds) ? clock() + seconds * 1000 : Date.parse(retry ?? '')
        store.query('UPDATE budget SET blocked = MAX(blocked, ?) WHERE id = 1').run(Math.max(clock() + 15 * 60_000, Number.isFinite(until) ? until : 0))
      }
      if (!res.ok)
        return res
      const body = await res.text()
      try {
        JSON.parse(body)
      }
      catch {
        store.query('UPDATE budget SET blocked = MAX(blocked, ?) WHERE id = 1').run(clock() + 15 * 60_000)
        return null
      }
      store.query('INSERT OR REPLACE INTO responses VALUES (?, ?, ?)').run(url, body, clock() + ttlMs)
      store.query('DELETE FROM responses WHERE expires <= ?').run(clock() - 24 * 3_600_000)
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    }
    catch {
      return null
    }
  }
  return {
    async get(input: string | URL, settings: { ttlMs?: number, timeoutMs?: number } = {}): Promise<Response | null> {
      const url = new URL(input)
      if (url.hostname !== 'site.web.api.espn.com' || url.protocol !== 'https:')
        throw new Error('Unsupported ESPN endpoint')
      url.searchParams.sort()
      const key = url.toString()
      let pending = inFlight.get(key)
      if (!pending) {
        pending = load(key, settings.ttlMs ?? 30_000, settings.timeoutMs ?? 8000)
        inFlight.set(key, pending)
      }
      try {
        return (await pending)?.clone() ?? null
      }
      finally {
        if (inFlight.get(key) === pending)
          inFlight.delete(key)
      }
    },
    close: () => store.close(),
  }
}

let shared: ReturnType<typeof createEspnClient> | undefined
export function espnFetch(url: string | URL, options: { ttlMs?: number, timeoutMs?: number } = {}): Promise<Response | null> {
  shared ??= createEspnClient()
  return shared.get(url, options)
}
