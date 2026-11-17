import type { Game } from '../../app/Services/scores/espn'
import { describe, expect, it } from 'bun:test'
import espn from '../fixtures/espn-exchange-games.json'
import kalshiFixture from '../fixtures/kalshi-games.json'
import polymarketFixture from '../fixtures/polymarket-games.json'
import { applyTicker, translate as translateKalshi } from '../../app/Services/odds/books/kalshi'
import { applyMessage, quotesFrom, translate as translatePolymarket } from '../../app/Services/odds/books/polymarket'
import { nearDate, streamable } from '../../app/Services/odds/books/exchange-games'
import { PushBuffer } from '../../app/Services/odds/push-buffer'

/**
 * Kalshi and Polymarket as books, against payloads the venues actually
 * sent on 17 Nov 2026 and ESPN's scoreboards for the same dates.
 *
 * What these pin: each exchange game lands on the ESPN game (canonical
 * names, real start time), every outcome is on the right side, and the
 * price is the cost of backing it, 1 / the YES ask, not the midpoint.
 */

const games = (key: string) => new Map<string, Game[]>([[key.split(':')[1]!, (espn as Record<string, Game[]>)[key]!]])

describe('kalshi translate', () => {
  const events = translateKalshi(kalshiFixture.nba as any, 'nba', games('nba:20261117'))

  it('turns ten outcome markets into five games', () => {
    expect(events).toHaveLength(5)
  })

  it('takes names and start times from ESPN, not Kalshi', () => {
    const knicks = events.find(event => event.externalId === 'KXNBAGAME-26NOV17NYKTOR')!
    expect(knicks.homeTeam).toBe('Toronto Raptors')
    expect(knicks.awayTeam).toBe('New York Knicks')
    expect(knicks.commenceAt).toMatch(/^2026-11-18T00:30/)
  })

  it('prices each side at 1 / its YES ask', () => {
    const knicks = events.find(event => event.externalId === 'KXNBAGAME-26NOV17NYKTOR')!
    const raw = (kalshiFixture.nba as any[]).find(m => m.ticker === 'KXNBAGAME-26NOV17NYKTOR-NYK')
    const away = knicks.books[0]!.markets[0]!.outcomes.find(o => o.side === 'away')!
    expect(away.price).toBeCloseTo(1 / Number(raw.yes_ask_dollars), 3)
    expect(away.sid).toBe('KXNBAGAME-26NOV17NYKTOR-NYK')
  })

  it('leaves out outcomes with no two-sided market', () => {
    // As recorded: a match three weeks out, 94-97¢ asks and no bids at all.
    expect(translateKalshi(kalshiFixture.epl as any, 'epl', games('epl:20261201'))).toHaveLength(0)
  })

  it('reads soccer as three-way, with the tie market as the draw', () => {
    // The same payload with a one-cent market under each ask.
    const quoted = (kalshiFixture.epl as any[]).map(market => ({ ...market, yes_ask_dollars: '0.3500', yes_bid_dollars: '0.3400' }))
    const [match] = translateKalshi(quoted, 'epl', games('epl:20261201'))
    const sides = match!.books[0]!.markets[0]!.outcomes.map(o => o.side).sort()
    expect(sides).toEqual(['away', 'draw', 'home'])
    expect(match!.homeTeam).toContain('Coventry')
  })

  it('skips a game ESPN cannot place instead of guessing', () => {
    expect(translateKalshi(kalshiFixture.nba as any, 'nba', new Map())).toHaveLength(0)
  })
})

describe('kalshi stream ticks', () => {
  it('moves only the outcome the tick names', () => {
    const state = new Map<string, any>([['KXNBAGAME-26NOV17NYKTOR', {
      eventTicker: 'KXNBAGAME-26NOV17NYKTOR',
      outcomes: new Map([
        ['KXNBAGAME-26NOV17NYKTOR-NYK', { ticker: 'KXNBAGAME-26NOV17NYKTOR-NYK', side: 'away', label: 'New York Knicks', bid: 0.6, ask: 0.61, volume: 1 }],
        ['KXNBAGAME-26NOV17NYKTOR-TOR', { ticker: 'KXNBAGAME-26NOV17NYKTOR-TOR', side: 'home', label: 'Toronto Raptors', bid: 0.38, ask: 0.39, volume: 1 }],
      ]),
    }]])
    // The message shape Kalshi sent on the ticker channel.
    const changed = applyTicker(state, { type: 'ticker', msg: { market_ticker: 'KXNBAGAME-26NOV17NYKTOR-NYK', yes_bid_dollars: '0.6100', yes_ask_dollars: '0.6200', volume_fp: '1576398.36' } })
    expect(changed).not.toBeNull()
    expect(changed!.outcomes.get('KXNBAGAME-26NOV17NYKTOR-NYK').ask).toBe(0.62)
    expect(changed!.outcomes.get('KXNBAGAME-26NOV17NYKTOR-TOR').ask).toBe(0.39)
  })

  it('ignores markets it does not carry', () => {
    expect(applyTicker(new Map(), { type: 'ticker', msg: { market_ticker: 'KXMVECROSSCATEGORY-X-Y', yes_ask_dollars: '0.2' } })).toBeNull()
  })
})

describe('polymarket translate', () => {
  const events = translatePolymarket(polymarketFixture.nba as any, 'nba', games('nba:20261117'))

  it('matches every game to ESPN', () => {
    expect(events).toHaveLength(5)
    expect(events.map(e => e.homeTeam)).toContain('San Antonio Spurs')
  })

  it('reads the moneyline, spreads and totals', () => {
    const types = new Set(events.flatMap(e => e.books[0]!.markets.map(m => m.marketType)))
    expect([...types].sort()).toEqual(['h2h', 'spreads', 'totals'])
  })

  it('signs a spread line from the home side', () => {
    for (const event of events) {
      for (const market of event.books[0]!.markets.filter(m => m.marketType === 'spreads')) {
        const home = market.outcomes.find(o => o.side === 'home')
        if (home)
          expect(market.line).toBe(home.point)
      }
    }
  })

  it('folds soccer\'s three yes/no markets into one three-way market', () => {
    const [match] = translatePolymarket(polymarketFixture.epl as any, 'epl', games('epl:20261121'))
    expect(match).toBeDefined()
    const h2h = match!.books[0]!.markets.find(m => m.marketType === 'h2h')!
    expect(h2h.outcomes.map(o => o.side).sort()).toEqual(['away', 'draw', 'home'])
    expect(match!.homeTeam).toBe('Manchester City')
  })
})

describe('polymarket stream messages', () => {
  it('reads the top of book per token from each message kind', () => {
    expect(quotesFrom({ event_type: 'price_change', price_changes: [{ asset_id: 'a', best_bid: '0.27', best_ask: '0.28' }] })).toEqual([{ token: 'a', bid: 0.27, ask: 0.28 }])
    expect(quotesFrom({ event_type: 'best_bid_ask', asset_id: 'a', best_bid: '0.27', best_ask: '0.28' })).toEqual([{ token: 'a', bid: 0.27, ask: 0.28 }])
    expect(quotesFrom({ event_type: 'book', asset_id: 'a', bids: [{ price: '0.01', size: '1' }, { price: '0.59', size: '1' }], asks: [{ price: '0.99', size: '1' }, { price: '0.61', size: '1' }] })).toEqual([{ token: 'a', bid: 0.59, ask: 0.61 }])
    expect(quotesFrom({ event_type: 'last_trade_price', asset_id: 'a' })).toEqual([])
  })

  it('reports each changed game once', () => {
    const game: any = { externalId: '1' }
    const index = new Map<string, any>([
      ['a', { game, token: { bid: 0.4, ask: 0.5 } }],
      ['b', { game, token: { bid: 0.4, ask: 0.5 } }],
    ])
    const changed = applyMessage(index, { event_type: 'price_change', price_changes: [{ asset_id: 'a', best_bid: '0.24', best_ask: '0.25' }, { asset_id: 'b', best_bid: '0.74', best_ask: '0.75' }] })
    expect(changed).toHaveLength(1)
    expect(index.get('a').token.ask).toBe(0.25)
  })
})

describe('push buffer', () => {
  it('keeps only the latest quote per book and game', async () => {
    const written: number[] = []
    const buffer = new PushBuffer(async (events) => { written.push(events.length) }, 60_000)
    const event = (price: number) => ({ externalId: 'g', sportSlug: 'nba', commenceAt: '', homeTeam: '', awayTeam: '', books: [{ key: 'kalshi', title: '', lastUpdate: '', markets: [{ marketType: 'h2h', line: null, outcomes: [{ side: 'home', label: '', point: null, price }] }] }] })
    buffer.add('kalshi', event(1.5))
    buffer.add('kalshi', event(1.6))
    buffer.add('polymarket', event(1.55))
    expect(buffer.size).toBe(2)
    expect(await buffer.flush()).toBe(2)
    expect(await buffer.flush()).toBe(0)
    expect(written).toEqual([2])
  })
})

describe('which games are worth the work', () => {
  const now = Date.parse('2026-11-17T22:00:00Z')

  it('looks up games dated yesterday to two days out', () => {
    expect(nearDate('20261116', now)).toBe(true)
    expect(nearDate('20261117', now)).toBe(true)
    expect(nearDate('20261119', now)).toBe(true)
    expect(nearDate('20261120', now)).toBe(false)
    expect(nearDate('20261115', now)).toBe(false)
    expect(nearDate('not-a-date', now)).toBe(false)
  })

  it('streams games starting within a day and a half, or live', () => {
    expect(streamable('2026-11-18T00:30:00Z', now)).toBe(true)
    expect(streamable('2026-11-17T18:00:00Z', now)).toBe(true)
    expect(streamable('2026-11-20T00:30:00Z', now)).toBe(false)
    expect(streamable('2026-11-17T12:00:00Z', now)).toBe(false)
  })
})
