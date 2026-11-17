import type { Game, Team } from '../../app/Services/scores/espn'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'bun:test'
import { candlesToPoints, parseRange, thin, windowFor } from '../../app/Services/prediction-markets/kalshi-chart'
import { clearKalshiCache, currentPrice, isMultivariate, kalshiMarkets, toMarketInfo } from '../../app/Services/prediction-markets/kalshi-public'
import { trackParlay } from '../../app/Services/trading/book-tracking'
import { reconcileSiblings } from '../../app/Services/trading/evidence'
import { flagsFor, movementFrom } from '../../app/Services/scanner'
import { KalshiTradingClient } from '../../app/Services/trading/kalshi-trading'
import { propKind, propProgress, spreadProgress, totalProgress } from '../../app/Services/trading/leg-progress'
import { candidateEvents, kalshiDate } from '../../app/Services/scores/kalshi-event'
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

  it('falls back to the market wording when a college code is spelled differently', () => {
    const games = [
      game(team('ACU', 'Abilene Christian', 30), team('MOST', 'Missouri State', 41)),
      game(team('SEMO', 'Southeast Missouri State', 20), team('MIDW', 'Midway', 18)),
    ]
    const ref = parseGameTicker('KXNCAAMBGAME-26NOV16ACMOSU-MOSU')!
    expect(matchGame(ref, games)).toBeNull()
    const found = matchGame(ref, games, 'Missouri St.')
    expect(found?.id).toBe('ACU-MOST')
    expect(liveGameCard(found!, ref, 'yes', 'Missouri St.')).toMatchObject({ rooting: 'home', standing: 'Ahead' })
    // A name that fits two games is no match at all.
    expect(matchGame(ref, [...games, game(team('X', 'Missouri State', 1), team('Y', 'Other', 2))], 'Missouri St.')).toBeNull()
  })

  it('maps women\'s college basketball and European soccer series', () => {
    expect(parseGameTicker('KXNCAAWBGAME-26NOV16LAMTXAM-TXAM')).toMatchObject({ league: 'ncaaw', code: 'LAMTXAM' })
    expect(parseGameTicker('KXUEFANLSPREAD-26NOV17BIHROU-ROU2')).toMatchObject({ league: 'uefa-nations', code: 'BIHROU', winner: false })
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

describe('finished but unsettled legs', () => {
  it('reads a finished game\'s leg from its price until Kalshi settles it', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('espn')) {
        return Response.json({ events: [{
          id: '1',
          date: '2026-11-17T00:00Z',
          status: { type: { state: 'post', shortDetail: 'Final' } },
          competitions: [{ competitors: [
            { homeAway: 'away', score: '115', team: { abbreviation: 'ORL', location: 'Orlando', displayName: 'Orlando Magic' } },
            { homeAway: 'home', score: '105', team: { abbreviation: 'BOS', location: 'Boston', displayName: 'Boston Celtics' } },
          ] }],
        }] })
      }
      return Response.json({ markets: [
        { ticker: 'KXNBASPREAD-26NOV16ORLBOS-ORL5', last_price_dollars: '0.99', result: '' },
        { ticker: 'KXNBAGAME-26NOV16ORLBOS-ORL', last_price_dollars: '0.99', result: '' },
      ] })
    }) as unknown as typeof fetch

    const parlay = await trackParlay(toMarketInfo({
      ticker: 'KXMVECROSSCATEGORY-S2-XYZ',
      yes_sub_title: 'no Orlando wins by over 5.5 points,yes Orlando',
      mve_selected_legs: [
        { event_ticker: 'KXNBASPREAD-26NOV16ORLBOS', market_ticker: 'KXNBASPREAD-26NOV16ORLBOS-ORL5', side: 'no' },
        { event_ticker: 'KXNBAGAME-26NOV16ORLBOS', market_ticker: 'KXNBAGAME-26NOV16ORLBOS-ORL', side: 'yes' },
      ],
    }))

    expect(parlay?.legs.map(leg => leg.status)).toEqual(['lost', 'won'])
    expect(parlay?.chance).toBe(0)
  })
})

describe('kalshi rate limits', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  it('retries a rate-limited read and succeeds', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls === 1
        ? new Response('{"error":{"code":"too_many_requests"}}', { status: 429, headers: { 'retry-after': '0.01' } })
        : Response.json({ balance: 1234 })
    }) as unknown as typeof fetch

    const client = new KalshiTradingClient({ venue: 'kalshi', apiKeyId: 'key', privateKeyPem: pem })
    expect(await client.fetchBalance()).toEqual({ available: 12.34 })
    expect(calls).toBe(2)
  })

  it('never retries a write', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}', { status: 429 })
    }) as unknown as typeof fetch

    const client = new KalshiTradingClient({ venue: 'kalshi', apiKeyId: 'key', privateKeyPem: pem })
    await expect(client.placeOrder({ marketExternalId: 'T', side: 'yes', size: 1, limitPrice: 0.5, clientOrderId: 'c1' } as any)).rejects.toThrow('429')
    expect(calls).toBe(1)
  })
})

describe('leg progress', () => {
  const liveGame = liveGameCard(game(team('PHX', 'Phoenix', 56), team('DEN', 'Denver', 53)), parseGameTicker('KXNBATOTAL-26NOV16PHXDEN-206'), 'yes')
  const box = {
    away: { labels: ['MIN', 'PTS', '3PT', 'REB', 'AST'], players: [{ name: 'Devin Booker', shortName: 'D. Booker', jersey: '1', position: 'G', starter: true, dnp: false, stats: ['18', '5', '1-4', '2', '3'] }] },
    home: { labels: ['MIN', 'PTS', '3PT', 'REB', 'AST'], players: [{ name: 'Nikola Jokić', shortName: 'N. Jokić', jersey: '15', position: 'C', starter: true, dnp: false, stats: ['20', '19', '0-1', '11', '6'] }] },
  }

  it('counts a player prop from the box score, accents and combos included', () => {
    expect(propKind('KXNBAPTS-26NOV16PHXDEN-DENNJOKIC15-20')).toBe('PTS')
    expect(propKind('KXNBAGAME-26NOV16PHXDEN-DEN')).toBeNull()
    expect(propProgress('PTS', 'Nikola Jokic: 20+', 'yes', box)).toMatchObject({ text: '19 PTS', target: 20, onTrack: false })
    expect(propProgress('PRA', 'Nikola Jokić: 30+', 'yes', box)).toMatchObject({ text: '36 PRA', onTrack: true })
    expect(propProgress('3PT', 'Devin Booker: 2+', 'no', box)).toMatchObject({ text: '1 3PM', onTrack: true })
    expect(propProgress('PTS', 'Someone Else: 10+', 'yes', box)).toBeNull()
  })

  it('reads totals and spreads from the score', () => {
    expect(totalProgress('Over 206.5 points', 'yes', liveGame)).toMatchObject({ text: '109 pts', target: 206.5, onTrack: false })
    expect(totalProgress('Over 206.5 points', 'no', liveGame)).toMatchObject({ onTrack: true })
    expect(spreadProgress('Phoenix wins by over 2.5 points', 'yes', liveGame)).toMatchObject({ text: 'PHX +3', onTrack: true })
    expect(spreadProgress('Denver wins by over 2.5 points', 'yes', liveGame)).toMatchObject({ text: 'DEN -3', onTrack: false })
  })
})

describe('kalshi game events', () => {
  it('spells the event the way Kalshi does, in Eastern time', () => {
    expect(kalshiDate('2026-11-17T00:00Z')).toBe('26NOV16')
    expect(candidateEvents('nba', { startsAt: '2026-11-17T01:00Z', away: team('GS', 'Golden State', null) as any, home: team('NO', 'New Orleans', null) as any }))
      .toEqual(['KXNBAGAME-26NOV16GSNO', 'KXNBAGAME-26NOV16GSNOP', 'KXNBAGAME-26NOV16GSWNO', 'KXNBAGAME-26NOV16GSWNOP'])
  })
})

describe('candidate coherence', () => {
  const candidate = (externalId: string, side: string, marketPrice: number, fairValue: number) => ({
    predictionMarketId: 1, venue: 'kalshi', externalId, question: '', category: '', side,
    marketPrice, fairValue, edge: fairValue - marketPrice, confidence: 0.8, liquidity: 0, evidence: [] as any[],
  })

  it('scales two sides of one game that both claim an edge back to 100%', () => {
    const list = [
      candidate('KXNBAGAME-26NOV16PHXDEN-PHX', 'yes', 0.56, 0.5923),
      candidate('KXNBAGAME-26NOV16PHXDEN-DEN', 'yes', 0.47, 0.5094),
    ]
    reconcileSiblings(list)
    expect(list[0]!.fairValue + list[1]!.fairValue).toBeCloseTo(1, 3)
    expect(list[0]!.edge).toBeLessThan(0)
    expect(list[1]!.evidence.at(-1)).toMatchObject({ kind: 'coherence' })
  })

  it('leaves unrelated markets and coherent three-way sets alone', () => {
    const list = [
      candidate('KXUEFANLGAME-26NOV17DENNOR-DEN', 'yes', 0.42, 0.46),
      candidate('KXUEFANLGAME-26NOV17DENNOR-TIE', 'yes', 0.24, 0.26),
      candidate('KXFEDDECISION-28JAN-H26', 'yes', 0.05, 0.09),
    ]
    reconcileSiblings(list)
    expect(list.map(c => c.fairValue)).toEqual([0.46, 0.26, 0.09])
  })
})

describe('scanner movement', () => {
  const candles = Array.from({ length: 61 }, (_, i) => ({
    ts: 1_000_000 + i * 60,
    close: 0.4 + (i >= 50 ? 0.1 : 0) + (i >= 58 ? 0.05 : 0),
    bid: null,
    ask: null,
    volume: i >= 46 ? 30 : 5,
  }))

  it('reads 5, 15, and 60 minute changes and a volume surge from minute candles', () => {
    const move = movementFrom(candles)
    expect(move.change5m).toBe(0.05)
    expect(move.change15m).toBe(0.15)
    expect(move.change60m).toBe(0.15)
    expect(move.volumeSurge).toBeGreaterThan(2)
    expect(flagsFor({ change15m: move.change15m, volumeSurge: move.volumeSurge, spread: 0.01 })).toEqual(['Rising fast', 'Volume surge'])
    expect(flagsFor({ change15m: -0.09, volumeSurge: 1, spread: 0.06 })).toEqual(['Falling fast', 'Wide spread'])
  })
})
