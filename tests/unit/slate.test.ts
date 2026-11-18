import type { Database } from '../../app/Support/db'
import type { LiveLine } from '../../app/Services/trading/line-snapshots'
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { paperParlays, parlayPayout, parlayPrice, placePaperParlay, settlePaperParlays } from '../../app/Services/trading/paper-parlays'
import { buildSlate, rankPicks } from '../../app/Services/trading/slate'
import { schemaFor } from '../support/schema'

const line = (over: Partial<LiveLine>): LiveLine => ({
  ticker: 'T', title: 'Team', league: 'nba', gameId: 'g', side: 'home', provider: 'DraftKings',
  bookProb: 0.6, bid: 0.55, ask: 0.56, minutes: 120, startsAt: '2026-11-19T00:00:00Z', ...over,
})

describe('ranking picks', () => {
  it('buys the side the book favours, one pick per game, strongest first', () => {
    const picks = rankPicks([
      line({ ticker: 'A-HOME', gameId: '1', bookProb: 0.62, bid: 0.55, ask: 0.56 }),
      // The other side of game 1 disagrees less: dropped.
      line({ ticker: 'A-AWAY', gameId: '1', side: 'away', bookProb: 0.38, bid: 0.43, ask: 0.44 }),
      // Book below Kalshi: buy NO at one minus the bid.
      line({ ticker: 'B-HOME', gameId: '2', bookProb: 0.5, bid: 0.54, ask: 0.55 }),
      // Too small a gap.
      line({ ticker: 'C-HOME', gameId: '3', bookProb: 0.56, bid: 0.55, ask: 0.56 }),
      // Outside the 25–85¢ band.
      line({ ticker: 'D-HOME', gameId: '4', bookProb: 0.97, bid: 0.9, ask: 0.91 }),
    ])
    expect(picks.map(p => p.line.ticker)).toEqual(['A-HOME', 'B-HOME'])
    expect(picks[1]!.side).toBe('no')
    expect(picks[1]!.price).toBe(0.46)
  })
})

describe('building a slate', () => {
  const picks = rankPicks(Array.from({ length: 8 }, (_, i) => line({ ticker: `G${i}`, gameId: String(i), bookProb: 0.7 - i * 0.01, bid: 0.55, ask: 0.56 })))

  it('spends the budget on three singles and two two-leg parlays from other games', () => {
    const slate = buildSlate(picks, { budget: 5, stake: 1 })
    expect(slate.singles.map(p => p.line.ticker)).toEqual(['G0', 'G1', 'G2'])
    expect(slate.parlays.map(legs => legs.map(p => p.line.ticker))).toEqual([['G3', 'G4'], ['G5', 'G6']])
  })

  it('reuses the strongest picks for parlays rather than reaching for weak ones', () => {
    const slate = buildSlate(picks.slice(0, 4), { budget: 5, stake: 1 })
    expect(slate.singles).toHaveLength(3)
    expect(slate.parlays).toHaveLength(2)
    for (const legs of slate.parlays)
      expect(new Set(legs.map(p => p.line.gameId)).size).toBe(2)
  })

  it('places nothing when nothing disagrees', () => {
    expect(buildSlate([], { budget: 5 })).toEqual({ singles: [], parlays: [] })
  })
})

describe('paper parlays', () => {
  const paths: string[] = []
  afterEach(() => {
    for (const path of paths.splice(0)) {
      for (const suffix of ['', '-shm', '-wal'])
        rmSync(`${path}${suffix}`, { force: true })
    }
  })
  const freshDb = () => {
    const path = `tests/temp/parlays-${paths.length}-${Bun.nanoseconds()}.sqlite`
    paths.push(path)
    return schemaFor(path, ['paper_parlays']) as unknown as Database
  }

  it('prices as the product of its legs and pays stake over price less the fee', () => {
    expect(parlayPrice([{ ticker: 'A', side: 'yes', price: 0.5, label: '' }, { ticker: 'B', side: 'no', price: 0.6, label: '' }])).toBe(0.3)
    // $1 at 30¢ is 3.33 contracts; Kalshi's fee comes off the payout.
    expect(parlayPayout(1, 0.3)).toBeGreaterThan(3.1)
    expect(parlayPayout(1, 0.3)).toBeLessThan(3.34)
  })

  it('settles lost on the first losing leg, won only when every leg wins', async () => {
    const db = freshDb()
    const legs = [{ ticker: 'A', side: 'yes' as const, price: 0.5, label: 'A' }, { ticker: 'B', side: 'no' as const, price: 0.6, label: 'B' }]
    await placePaperParlay(db, { userId: 1, strategyId: null, stake: 1, legs })
    await placePaperParlay(db, { userId: 1, strategyId: null, stake: 1, legs: [legs[0]!, { ticker: 'C', side: 'yes', price: 0.4, label: 'C' }] })

    // A won, B still open, C lost.
    const first = await settlePaperParlays(db, async () => new Map([['A', 'yes'], ['B', ''], ['C', 'no']]))
    expect(first).toEqual({ settled: 1, won: 0, lost: 1 })

    const second = await settlePaperParlays(db, async () => new Map([['A', 'yes'], ['B', 'no']]))
    expect(second).toEqual({ settled: 1, won: 1, lost: 0 })
    const rows = await paperParlays(db, 1, 'settled')
    expect(rows.find(r => r.legs.some(l => l.ticker === 'B'))!.payout).toBeGreaterThan(3)
  })

  it('refuses a parlay of one leg or the same market twice', async () => {
    const db = freshDb()
    const leg = { ticker: 'A', side: 'yes' as const, price: 0.5, label: 'A' }
    await expect(placePaperParlay(db, { userId: 1, strategyId: null, stake: 1, legs: [leg] })).rejects.toThrow('two legs')
    await expect(placePaperParlay(db, { userId: 1, strategyId: null, stake: 1, legs: [leg, leg] })).rejects.toThrow('same market')
  })
})
