import type { Database } from '../../app/Support/db'
import type { LiveLine } from '../../app/Services/trading/line-snapshots'
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { approveSuggestion, dismissSuggestion, generateSuggestions, listSuggestions } from '../../app/Services/trading/suggestions'
import { schemaFor } from '../support/schema'

const TABLES = ['bet_suggestions', 'paper_parlays', 'trading_strategies', 'prediction_markets', 'trade_decisions', 'exchange_orders', 'exchange_positions']
const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal'])
      rmSync(`${path}${suffix}`, { force: true })
  }
})
function freshDb(): Database {
  const path = `tests/temp/suggest-${paths.length}-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  return schemaFor(path, TABLES) as unknown as Database
}

// Noon US Eastern, so games three hours later are still today.
const NOW = Date.parse('2026-11-18T17:00:00Z')
const soon = new Date(NOW + 3 * 3_600_000).toISOString()
const line = (i: number, over: Partial<LiveLine> = {}): LiveLine => ({
  ticker: `KXNBAGAME-26NOV18G${i}-T${i}`, title: `Team ${i}`, league: 'nba', gameId: String(i), side: 'home', provider: 'DraftKings',
  // The book likes each team a little more than Kalshi does, by a shrinking margin.
  bookProb: 0.6 + 0.03 - i * 0.002, bid: 0.59, ask: 0.6, minutes: 180, startsAt: soon, live: false, ...over,
})

describe('suggestions', () => {
  it('suggests singles, parlays and a live-leg parlay, once each', async () => {
    const db = freshDb()
    const lines = [...Array.from({ length: 7 }, (_, i) => line(i)), line(9, { live: true, bookProb: 0.7, bid: 0.69, ask: 0.7, minutes: -40 })]
    expect(await generateSuggestions(db, 1, { lines, now: NOW })).toBe(6)
    // Run again: nothing new.
    expect(await generateSuggestions(db, 1, { lines, now: NOW })).toBe(0)

    const { pending } = await listSuggestions(db, 1, NOW)
    expect(pending.filter(s => s.kind === 'single')).toHaveLength(3)
    const liveParlay = pending.find(s => s.legs.some(leg => leg.live))!
    expect(liveParlay.kind).toBe('parlay')
    // A live leg's price moves: its suggestion is short-lived.
    expect(Date.parse(liveParlay.expiresAt) - NOW).toBe(15 * 60_000)
  })

  it('approves a single and a parlay as paper bets, and dismisses', async () => {
    const db = freshDb()
    await generateSuggestions(db, 1, { lines: Array.from({ length: 7 }, (_, i) => line(i)), now: NOW })
    const { pending } = await listSuggestions(db, 1, NOW)
    const single = pending.find(s => s.kind === 'single')!
    const parlay = pending.find(s => s.kind === 'parlay')!

    const approved = await approveSuggestion(db, 1, single.id, NOW)
    expect(approved.status).toBe('approved')
    expect((db as any).prepare('SELECT * FROM exchange_positions').all()).toHaveLength(1)

    expect((await approveSuggestion(db, 1, parlay.id, NOW)).outcome).toContain('paper parlay')
    expect((db as any).prepare('SELECT * FROM paper_parlays').all()).toHaveLength(1)

    const other = pending.find(s => s.id !== single.id && s.id !== parlay.id)!
    await dismissSuggestion(db, 1, other.id, NOW)
    await expect(approveSuggestion(db, 1, other.id, NOW)).rejects.toThrow('already dismissed')
    // Someone else's suggestion is not reachable.
    await expect(approveSuggestion(db, 2, single.id, NOW)).rejects.toThrow('not yours')
  })

  it('builds parlays of several live legs while games run, each paying at least 2x', async () => {
    const db = freshDb()
    // In-play favourites at 80¢: it takes four of them to reach 2x (0.8^4 = 0.41).
    const live = (i: number) => line(20 + i, { live: true, bookProb: 0.8, bid: 0.79, ask: 0.8, minutes: -30 })
    await generateSuggestions(db, 1, { lines: [live(1), live(2), live(3), live(4), line(1), line(2)], now: NOW })
    const parlays = (await listSuggestions(db, 1, NOW)).pending.filter(s => s.kind === 'parlay')
    const allLive = parlays.filter(s => s.legs.every(leg => leg.live))
    expect(allLive.map(s => s.legs.length)).toEqual([4])
    expect(parlays.some(s => s.legs.some(leg => leg.live) && s.legs.some(leg => !leg.live))).toBe(true)
    for (const parlay of parlays)
      expect(1 / parlay.price).toBeGreaterThanOrEqual(2)
  })

  it('leaves out games that do not finish today', async () => {
    const db = freshDb()
    const tomorrow = new Date(NOW + 30 * 3_600_000).toISOString()
    expect(await generateSuggestions(db, 1, { lines: [line(1, { startsAt: tomorrow })], now: NOW })).toBe(0)
  })

  it('expires suggestions once their game starts', async () => {
    const db = freshDb()
    await generateSuggestions(db, 1, { lines: [line(1)], now: NOW })
    const later = Date.parse(soon) + 60_000
    expect((await listSuggestions(db, 1, later)).pending).toHaveLength(0)
  })
})
