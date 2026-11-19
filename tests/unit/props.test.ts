import { describe, expect, it } from 'bun:test'
import { toMarketInfo } from '../../app/Services/prediction-markets/kalshi-public'
import { parsePropTitle, propLines } from '../../app/Services/trading/props'
import type { LiveGame } from '../../app/Services/trading/live-games'

const at = '2026-11-19T01:00:00Z'
const game = { gameId: '401', startsAt: at, state: 'pre' } as LiveGame
const market = (series: string, extra: object = {}) => toMarketInfo({
  ticker: `${series}-26NOV18UTALAL-LALLDONCIC77-25`, event_ticker: `${series}-26NOV18UTALAL`,
  status: 'active', yes_sub_title: 'Luka Dončić: 25+', yes_bid_dollars: '0.80', yes_ask_dollars: '0.82', ...extra,
})

describe('player prop lines', () => {
  it('preserves threshold and stat, pricing at mid, with one game read across stat ladders', async () => {
    let games = 0
    const lines = await propLines({ now: () => Date.parse(at) - 60_000, openMarkets: async series => [market(series)], gameFor: async () => { games++; return game } })
    expect(lines).toHaveLength(5)
    expect(lines[0]!.title).toBe('Luka Dončić: 25+ points')
    expect(lines[0]!.bookProb).toBe(0.81)
    expect(new Set(lines.map(line => line.gameId)).size).toBe(1)
    expect(games).toBe(1)
    expect(parsePropTitle('Malformed')).toBeNull()
  })

  it('rejects crossed quotes, final markets, wide spreads and finished games', async () => {
    const lines = await propLines({ now: () => 0, openMarkets: async series => [market(series, { yes_bid_dollars: '0.83' }), market(series, { status: 'finalized' }), market(series, { yes_bid_dollars: '0.70' })], gameFor: async () => game })
    expect(lines).toEqual([])
    expect(await propLines({ now: () => 0, openMarkets: async series => [market(series)], gameFor: async () => ({ ...game, state: 'post' }) })).toEqual([])
  })

  it('suppresses pregame props for reported unavailable players', async () => {
    expect(await propLines({ now: () => 0, unavailable: async () => new Set(['lukadoncic']), openMarkets: async series => [market(series)], gameFor: async () => game })).toEqual([])
  })
})
