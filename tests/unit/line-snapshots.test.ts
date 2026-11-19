import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import type { Database } from '../../app/Support/db'
import { bookProbability, impliedFromAmerican, linesReport, liveLines, recordLines } from '../../app/Services/trading/line-snapshots'
import { schemaFor } from '../support/schema'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal'])
      rmSync(`${path}${suffix}`, { force: true })
  }
})

function freshDb() {
  const path = `tests/temp/lines-${paths.length}-${Bun.nanoseconds()}.sqlite`
  paths.push(path)
  // The bun:sqlite handle answers the same query()/all()/run() calls.
  return schemaFor(path, ['line_snapshots']) as unknown as Database
}

describe('book probability', () => {
  it('converts American odds and removes a two-way margin', () => {
    expect(impliedFromAmerican(-200)).toBeCloseTo(0.6667, 3)
    expect(impliedFromAmerican(150)).toBeCloseTo(0.4, 3)
    const home = bookProbability(-197, 164, 'home')!
    const away = bookProbability(-197, 164, 'away')!
    expect(home + away).toBeCloseTo(1, 6)
    expect(home).toBeCloseTo(0.6365, 3)
  })

  it('shares a soccer margin across home, draw and away', () => {
    const parts = (['home', 'draw', 'away'] as const).map(side => bookProbability(-250, 600, side, 425)!)
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(parts[1]).toBeGreaterThan(0.15)
    // No draw price, no draw probability; and a two-way read of a three-way line is refused.
    expect(bookProbability(-250, 600, 'draw')).toBeNull()
  })

  it('refuses prices that are not a moneyline', () => {
    expect(bookProbability(null, 150, 'home')).toBeNull()
    expect(bookProbability(500, 500, 'home')).toBeNull()
  })
})

describe('recording and scoring lines', () => {
  const NOW = Date.parse('2026-11-18T23:30:00Z')
  const game = (selected: 'home' | 'away' | null, startsAt = '2026-11-19T00:00:00Z') => ({ league: 'nba', gameId: '1', state: 'pre', selected, startsAt } as any)

  it('can quote a pre-game winner for suggestions while the sportsbook is unavailable', async () => {
    const deps = {
      openMarkets: async (series: string) => series === 'KXNBAGAME'
        ? [{ ticker: 'KXNBAGAME-26NOV18MEMCLE-CLE', yesBid: 0.74, yesAsk: 0.76 }] as any[]
        : [],
      gameFor: async () => game('home'),
      detailFor: async () => null,
      now: () => NOW,
    }
    expect(await liveLines(deps)).toEqual([])
    expect(await liveLines(deps, 180, { allowKalshiOnly: true })).toMatchObject([
      { provider: 'Kalshi', bookProb: 0.75, bid: 0.74, ask: 0.76, live: false },
    ])
  })

  it('records games within three hours, soccer ties against the draw, and scores them once settled', async () => {
    const db = freshDb()
    const markets: Record<string, any[]> = {
      KXNBAGAME: [
        { ticker: 'KXNBAGAME-26NOV18MEMCLE-CLE', yesBid: 0.6, yesAsk: 0.61 },
        { ticker: 'KXNBAGAME-26NOV18MEMCLE-MEM', yesBid: 0.38, yesAsk: 0.4 },
        { ticker: 'KXNBAGAME-26NOV20GSMEM-MEM', yesBid: 0.5, yesAsk: 0.52 },
      ],
      KXEPLGAME: [{ ticker: 'KXEPLGAME-26NOV18FULMNC-TIE', yesBid: 0.18, yesAsk: 0.2 }],
    }
    const result = await recordLines(db, {
      openMarkets: async series => markets[series] ?? [],
      gameFor: async (ticker) => {
        if (ticker.includes('NOV20'))
          return game('home', '2026-11-21T00:00:00Z')
        if (ticker.endsWith('TIE'))
          return { ...game(null), league: 'epl', gameId: '2' }
        return game(ticker.endsWith('CLE') ? 'home' : 'away')
      },
      detailFor: async (league) => ({ odds: league === 'epl'
        ? { provider: 'DraftKings', homeMoneyLine: -250, awayMoneyLine: 600, drawMoneyLine: 425 }
        : { provider: 'DraftKings', homeMoneyLine: -240, awayMoneyLine: 196, drawMoneyLine: null } } as any),
      now: () => NOW,
    })
    expect(result.recorded).toBe(3)
    const sides = (await db.query<{ side: string }>('SELECT side FROM line_snapshots ORDER BY ticker').all()).map(r => r.side)
    expect(sides).toEqual(['draw', 'home', 'away'])

    // CLE: the book says ~69%, Kalshi 60.5% → buy YES at 61¢. CLE won.
    const report = await linesReport(db, { results: async () => new Map([['KXNBAGAME-26NOV18MEMCLE-CLE', 'yes'], ['KXNBAGAME-26NOV18MEMCLE-MEM', 'no']]) })
    expect(report.settled).toBe(2)
    const cle = report.bets.find(bet => bet.ticker.endsWith('CLE'))!
    expect(cle.side).toBe('yes')
    expect(cle.price).toBe(0.61)
    expect(cle.won).toBe(true)
    expect(report.brier.book!).toBeLessThan(report.brier.kalshi!)
  })
})
