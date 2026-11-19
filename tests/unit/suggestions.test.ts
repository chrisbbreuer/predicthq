import type { Database } from '../../app/Support/db'
import type { LiveLine } from '../../app/Services/trading/line-snapshots'
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { approveSuggestion, dismissSuggestion, generateSuggestions, listSuggestions } from '../../app/Services/trading/suggestions'
import { parlayPayout } from '../../app/Services/trading/paper-parlays'
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
    expect(await generateSuggestions(db, 1, { lines, props: [], now: NOW })).toBe(6)
    // Run again: nothing new.
    expect(await generateSuggestions(db, 1, { lines, props: [], now: NOW })).toBe(0)

    const { pending } = await listSuggestions(db, 1, NOW)
    expect(pending.filter(s => s.kind === 'single')).toHaveLength(3)
    const liveParlay = pending.find(s => s.legs.some(leg => leg.live))!
    expect(liveParlay.kind).toBe('parlay')
    // A live leg's price moves: its suggestion is short-lived.
    expect(Date.parse(liveParlay.expiresAt) - NOW).toBe(15 * 60_000)
  })

  it('approves a single and a parlay as paper bets, and dismisses', async () => {
    const db = freshDb()
    await generateSuggestions(db, 1, { lines: Array.from({ length: 7 }, (_, i) => line(i)), props: [], now: NOW })
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
    await generateSuggestions(db, 1, { lines: [live(1), live(2), live(3), live(4), line(1), line(2)], props: [], now: NOW })
    const parlays = (await listSuggestions(db, 1, NOW)).pending.filter(s => s.kind === 'parlay')
    const allLive = parlays.filter(s => s.legs.every(leg => leg.live))
    expect(allLive.map(s => s.legs.length)).toEqual([4])
    expect(parlays.some(s => s.legs.some(leg => leg.live) && s.legs.some(leg => !leg.live))).toBe(true)
    for (const parlay of parlays)
      expect(1 / parlay.price).toBeGreaterThanOrEqual(2)
  })

  it('builds player-prop parlays from the cheapest bought-down overs, one line per game, paying 2x after fees', async () => {
    const db = freshDb()
    const prop = (player: string, threshold: number, bid: number, ask: number) => line(0, {
      ticker: `KXNBAPTS-26NOV18UTALAL-${player}-${threshold}`, title: `${player} ${threshold}+ points`, league: 'nba-props',
      gameId: `g:${player}`, bid, ask, bookProb: (bid + ask) / 2, prop: true,
    })
    const props = [
      prop('LUKA', 25, 0.81, 0.82), prop('LUKA', 20, 0.81, 0.83), prop('LUKA', 30, 0.55, 0.57), // only the 25+ line is in the band
      prop('LEBRON', 20, 0.79, 0.8), prop('REAVES', 15, 0.8, 0.81), prop('AYTON', 10, 0.82, 0.83),
      prop('WIDE', 10, 0.7, 0.8),
      { ...prop('TEAMMATE', 10, 0.82, 0.84), gameId: 'g:LUKA' }, // spread too wide
    ]
    await generateSuggestions(db, 1, { lines: [], props, now: NOW })
    const parlays = (await listSuggestions(db, 1, NOW)).pending.filter(s => s.kind === 'parlay')
    expect(parlays).toHaveLength(1)
    const legs = parlays[0]!.legs
    expect(legs).toHaveLength(4)
    expect(new Set(legs.map(leg => leg.ticker.split('-')[2])).size).toBe(4)
    expect(legs.every(leg => leg.side === 'yes')).toBe(true)
    expect(legs.some(leg => leg.ticker.includes('WIDE'))).toBe(false)
    expect(parlayPayout(1, parlays[0]!.price)).toBeGreaterThanOrEqual(2)
    expect(legs.some(leg => leg.ticker.includes('TEAMMATE'))).toBe(false)
    expect(legs[0]!.label).toContain('+ points')
  })

  it('uses an alternate threshold when the cheapest-cost legs alone miss the payout floor', async () => {
    const db = freshDb()
    const props = Array.from({ length: 4 }, (_, i) => line(i, { prop: true, league: 'nba-props', bookProb: 0.84, bid: 0.84, ask: 0.84 }))
    props.push(line(0, { prop: true, league: 'nba-props', ticker: 'ALTERNATE', bookProb: 0.79, bid: 0.78, ask: 0.8 }))
    await generateSuggestions(db, 1, { lines: [], props, now: NOW })
    const parlays = (await listSuggestions(db, 1, NOW)).pending
    expect(parlays).toHaveLength(1)
    expect(parlays[0]!.legs.some(leg => leg.ticker === 'ALTERNATE')).toBe(true)
    expect(new Set(parlays[0]!.legs.map(leg => leg.ticker)).size).toBe(4)
    expect(parlayPayout(1, parlays[0]!.price)).toBeGreaterThanOrEqual(2)
  })

  it('leaves out games that do not finish today', async () => {
    const db = freshDb()
    const tomorrow = new Date(NOW + 30 * 3_600_000).toISOString()
    expect(await generateSuggestions(db, 1, { lines: [line(1, { startsAt: tomorrow })], props: [], now: NOW })).toBe(0)
  })

  it('expires suggestions once their game starts', async () => {
    const db = freshDb()
    await generateSuggestions(db, 1, { lines: [line(1)], props: [], now: NOW })
    const later = Date.parse(soon) + 60_000
    expect((await listSuggestions(db, 1, later)).pending).toHaveLength(0)
  })
})
