import type { Game, Team } from '../../app/Services/scores/espn'
import { afterEach, describe, expect, it } from 'bun:test'
import { candlesToPoints, parseRange, thin, windowFor } from '../../app/Services/prediction-markets/kalshi-chart'
import { clearKalshiCache, currentPrice, isMultivariate, kalshiMarkets, toMarketInfo } from '../../app/Services/prediction-markets/kalshi-public'
import { trackParlay } from '../../app/Services/trading/book-tracking'
import { liveGameCard, matchGame, parseGameTicker, sideForOutcome } from '../../app/Services/trading/live-games'

function team(abbreviation: string, location: string, score: number | null): Team {
  return { abbreviation, location, name: `${location} Team`, shortName: location, score, record: null, winner: false, logo: '', color: '#123456' }
}

function game(away: Team, home: Team, state: 'pre' | 'in' | 'post' = 'in'): Game {
  return {
    id: `${away.abbreviation}-${home.abbreviation}`,
    league: 'nba',
    startsAt: '2026-11-17T00:00Z',
    state,
    status: state === 'in' ? '9:00 - 2nd' : 'Final',
    clock: state === 'in' ? '9:00' : '',
    venue: null,
    broadcast: null,
    away,
    home,
    period: 2,
    lastPlay: 'Defensive rebound.',
  }
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearKalshiCache()
})

describe('kalshi game tickers', () => {
  it('reads the league, date, teams, and outcome from a winner market', () => {
    expect(parseGameTicker('KXNBAGAME-26NOV16ORLBOS-BOS')).toEqual({
      series: 'KXNBAGAME',
      league: 'nba',
      date: '20261116',
      code: 'ORLBOS',
      outcome: 'BOS',
      eventTicker: 'KXNBAGAME-26NOV16ORLBOS',
      winner: true,
    })
  })

  it('treats props, spreads, and other leagues as the same game but not as winner markets', () => {
    expect(parseGameTicker('KXNBAPTS-26NOV16ORLBOS-BOSJTATUM0-20')).toMatchObject({ league: 'nba', code: 'ORLBOS', winner: false })
    expect(parseGameTicker('KXNCAAMBGAME-26NOV18DUKEUNC-DUKE')).toMatchObject({ league: 'ncaab', winner: true })
    expect(parseGameTicker('KXWNBAGAME-26JUN05LVANYL-LVA')).toMatchObject({ league: 'wnba' })
  })

  it('refuses tickers that are not about a dated game', () => {
    expect(parseGameTicker('KXFEDDECISION-28JAN-H26')).toBeNull()
    expect(parseGameTicker('KXNFLWINS-TEN-26')).toBeNull()
    expect(parseGameTicker('KXMVECROSSCATEGORY-S2026ABC-XYZ')).toBeNull()
    expect(parseGameTicker('')).toBeNull()
  })

  it('finds the game even where ESPN and Kalshi abbreviate differently', () => {
    const games = [
      game(team('MEM', 'Memphis', 33), team('WSH', 'Washington', 35)),
      game(team('GS', 'Golden State', 50), team('NO', 'New Orleans', 48)),
      game(team('ORL', 'Orlando', 28), team('BOS', 'Boston', 25)),
    ]
    expect(matchGame(parseGameTicker('KXNBAGAME-26NOV16GSWNOP-GSW')!, games)?.id).toBe('GS-NO')
    expect(matchGame(parseGameTicker('KXNBAGAME-26NOV16MEMWAS-WAS')!, games)?.id).toBe('MEM-WSH')
    expect(matchGame(parseGameTicker('KXNBAGAME-26NOV16ORLBOS-BOS')!, games)?.id).toBe('ORL-BOS')
    expect(matchGame(parseGameTicker('KXNBAGAME-26NOV16PHXDEN-DEN')!, games)).toBeNull()
  })

  it('knows which side an outcome names', () => {
    const g = game(team('GS', 'Golden State', 50), team('NO', 'New Orleans', 48))
    expect(sideForOutcome('GSW', g)).toBe('away')
    expect(sideForOutcome('NOP6', g)).toBe('home')
    expect(sideForOutcome('220', g)).toBeNull()
  })
})

describe('live game card', () => {
  const g = game(team('ORL', 'Orlando', 28), team('BOS', 'Boston', 25))

  it('roots for the named team on YES and reports the standing', () => {
    const card = liveGameCard(g, parseGameTicker('KXNBAGAME-26NOV16ORLBOS-BOS'), 'yes')
    expect(card).toMatchObject({ selected: 'home', rooting: 'home', standing: 'Behind', tone: 'neg', lastPlay: 'Defensive rebound.', gameUrl: '/scores/nba/game/ORL-BOS' })
  })

  it('roots for the other team on NO', () => {
    const card = liveGameCard(g, parseGameTicker('KXNBAGAME-26NOV16ORLBOS-BOS'), 'no')
    expect(card).toMatchObject({ rooting: 'away', standing: 'Ahead', tone: 'pos' })
  })

  it('calls a finished game won or lost, and a prop just live', () => {
    const final = game(team('ORL', 'Orlando', 101), team('BOS', 'Boston', 110), 'post')
    expect(liveGameCard(final, parseGameTicker('KXNBAGAME-26NOV16ORLBOS-BOS'), 'yes').standing).toBe('Won')
    expect(liveGameCard(final, parseGameTicker('KXNBAGAME-26NOV16ORLBOS-ORL'), 'yes').standing).toBe('Lost')
    expect(liveGameCard(g, parseGameTicker('KXNBAPTS-26NOV16ORLBOS-BOSJTATUM0-20'), 'yes')).toMatchObject({ rooting: null, standing: 'Live' })
  })
})

describe('probability charts', () => {
  it('uses trades, then a tight quote, then carries the last value forward', () => {
    const points = candlesToPoints([
      { ts: 60, close: null, bid: 0.1, ask: 0.9, volume: 0 },
      { ts: 120, close: 0.62, bid: 0.6, ask: 0.63, volume: 4 },
      { ts: 180, close: null, bid: 0.64, ask: 0.66, volume: 0 },
      { ts: 240, close: null, bid: 0.2, ask: 0.9, volume: 0 },
    ])
    expect(points).toEqual([[120, 0.62], [180, 0.65], [240, 0.65]])
  })

  it('thins long series but keeps both ends', () => {
    const long = Array.from({ length: 1000 }, (_, i) => [i, i / 1000] as [number, number])
    const thinned = thin(long, 50)
    expect(thinned).toHaveLength(50)
    expect(thinned[0]).toEqual([0, 0])
    expect(thinned[49]).toEqual([999, 0.999])
  })

  it('picks a window and candle size per range', () => {
    const now = 2_000_000_000
    expect(windowFor('1d', now, null, null)).toMatchObject({ start: now - 86_400, interval: 1 })
    expect(windowFor('1w', now, null, null)).toMatchObject({ interval: 60 })
    expect(windowFor('all', now, now - 200 * 86_400, null)).toMatchObject({ interval: 1440 })
    // Live starts shortly before tip-off, never before the market opened.
    expect(windowFor('live', now, null, now - 3600).start).toBe(now - 3600 - 1200)
    expect(windowFor('live', now, now - 600, now - 3600).start).toBe(now - 600)
    expect(parseRange('ALL')).toBe('all')
    expect(parseRange('forever')).toBe('live')
  })

  it('prefers the quote midpoint and honours a settlement', () => {
    expect(currentPrice({ lastPrice: 0.5, yesBid: 0.66, yesAsk: 0.68, status: 'active', result: '' })).toBe(0.67)
    expect(currentPrice({ lastPrice: 0.5, yesBid: 0.1, yesAsk: 0.9, status: 'active', result: '' })).toBe(0.5)
    expect(currentPrice({ lastPrice: 0.5, yesBid: null, yesAsk: null, status: 'finalized', result: 'no' })).toBe(0)
  })
})

describe('parlay markets', () => {
  it('asks for multivariate markets with the filter Kalshi requires', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      const tickers = new URL(url).searchParams.get('tickers')!.split(',')
      return Response.json({ markets: tickers.map(ticker => ({ ticker, title: ticker, last_price_dollars: '0.5' })) })
    }) as typeof fetch

    const markets = await kalshiMarkets(['KXNBAGAME-26NOV16ORLBOS-BOS', 'KXMVECROSSCATEGORY-S1-ABC'])
    expect(markets.size).toBe(2)
    expect(isMultivariate('KXMVECROSSCATEGORY-S1-ABC')).toBe(true)
    expect(urls.find(url => url.includes('KXMVE'))).toContain('mve_filter=only')
    expect(urls.find(url => url.includes('KXNBAGAME'))).not.toContain('mve_filter')
  })

  it('prices each leg for the holder and multiplies what is left', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('espn'))
        return Response.json({ events: [] })
      return Response.json({
        markets: [
          { ticker: 'KXNBAGAME-26NOV16ORLBOS-BOS', yes_bid_dollars: '0.70', yes_ask_dollars: '0.72', result: '' },
          { ticker: 'KXNBAGAME-26NOV16PORMIN-MIN', last_price_dollars: '0.40', result: '' },
          { ticker: 'KXNBAGAME-26NOV16CHICLE-CLE', last_price_dollars: '0.99', result: 'yes' },
        ],
      })
    }) as typeof fetch

    const parlay = await trackParlay(toMarketInfo({
      ticker: 'KXMVECROSSCATEGORY-S1-ABC',
      yes_sub_title: 'yes Boston,no Minnesota,yes Cleveland',
      mve_selected_legs: [
        { event_ticker: 'KXNBAGAME-26NOV16ORLBOS', market_ticker: 'KXNBAGAME-26NOV16ORLBOS-BOS', side: 'yes' },
        { event_ticker: 'KXNBAGAME-26NOV16PORMIN', market_ticker: 'KXNBAGAME-26NOV16PORMIN-MIN', side: 'no' },
        { event_ticker: 'KXNBAGAME-26NOV16CHICLE', market_ticker: 'KXNBAGAME-26NOV16CHICLE-CLE', side: 'yes' },
      ],
    }), async () => [])

    expect(parlay?.legs.map(leg => [leg.label, leg.status, leg.chance])).toEqual([
      ['Boston', 'open', 0.71],
      ['Minnesota', 'open', 0.6],
      ['Cleveland', 'won', 1],
    ])
    expect(parlay?.won).toBe(1)
    expect(parlay?.chance).toBe(0.426)
  })
})
