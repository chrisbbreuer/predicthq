import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync, utimesSync } from 'node:fs'
import { beat, clearBeat, STALE_MS, watcherLive } from '../../app/Services/odds/watcher-heartbeat'

const path = `tests/temp/heartbeat-${Bun.nanoseconds()}/.odds-watch.heartbeat`
afterEach(() => rmSync(path, { force: true }))

describe('odds watcher heartbeat', () => {
  it('reads as live while fresh, and not once stale, cleared or never written', () => {
    expect(watcherLive(Date.now(), path)).toBe(false)
    beat(path)
    expect(watcherLive(Date.now(), path)).toBe(true)

    const old = new Date(Date.now() - STALE_MS - 1000)
    utimesSync(path, old, old)
    expect(watcherLive(Date.now(), path)).toBe(false)

    beat(path)
    clearBeat(path)
    expect(watcherLive(Date.now(), path)).toBe(false)
  })
})
