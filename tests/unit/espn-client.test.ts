import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEspnClient } from '../../app/Services/scores/espn-client'

const root = mkdtempSync(join(tmpdir(), 'predicthq-espn-test-'))
const clients: ReturnType<typeof createEspnClient>[] = []
let id = 0
afterEach(() => { for (const client of clients.splice(0)) client.close() })
function client(options: Parameters<typeof createEspnClient>[0] = {}) {
  const result = createEspnClient({ path: join(root, `${id++}.sqlite`), ...options })
  clients.push(result)
  return result
}
const URL = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'

describe('shared ESPN client', () => {
  it('coalesces simultaneous reads and shares cached JSON across clients', async () => {
    let calls = 0
    const transport = (async () => { calls++; return Response.json({ events: [1] }) }) as typeof fetch
    const path = join(root, `${id++}.sqlite`)
    const a = client({ path, fetch: transport })
    const b = client({ path, fetch: transport })
    const responses = await Promise.all([a.get(URL), a.get(URL)])
    expect(await responses[0]!.json()).toEqual({ events: [1] })
    expect(await responses[1]!.json()).toEqual({ events: [1] })
    expect(await (await b.get(URL))!.json()).toEqual({ events: [1] })
    expect(calls).toBe(1)
  })

  it('stops all endpoints after refusal, honors Retry-After, and probes again after cooldown', async () => {
    let now = 1_000_000
    let calls = 0
    const a = client({ now: () => now, fetch: (async () => {
      calls++
      return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1800' } }) : Response.json({ ok: true })
    }) as typeof fetch })
    expect((await a.get(URL))!.status).toBe(429)
    now += 16 * 60_000
    expect(await a.get(`${URL}?dates=20261118`)).toBeNull()
    expect(calls).toBe(1)
    now += 15 * 60_000
    expect((await a.get(URL))!.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('enforces the same request budget across clients and resets the window', async () => {
    let now = 1_000_000
    const path = join(root, `${id++}.sqlite`)
    const settings = { path, budget: 1, now: () => now, fetch: (async () => Response.json({ ok: true })) as typeof fetch }
    const a = client(settings)
    const b = client(settings)
    expect((await a.get(URL))!.status).toBe(200)
    expect(await b.get(`${URL}?dates=20261118`)).toBeNull()
    now += 60_000
    expect((await b.get(`${URL}?dates=20261118`))!.status).toBe(200)
  })

  it('does not cache HTML block responses as valid JSON', async () => {
    const a = client({ fetch: (async () => new Response('<html>Access denied</html>')) as typeof fetch })
    expect(await a.get(URL)).toBeNull()
  })
})
// Each database is closed above; this directory contains only this suite's disposable data.
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
