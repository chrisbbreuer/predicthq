import type { SportRow } from '../../ingest/resolve'
import type { Game } from '../../scores/espn'
import type { FeedEvent, FeedMarket, FeedOutcome } from '../provider'
import type { BookAdapter, BookContext, Subscription } from './adapter'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { findGame, gamesForDates, nearDate, quotable, share, streamable } from './exchange-games'

/**
 * Polymarket, as a book.
 *
 * Polymarket groups a game as one Gamma "event" holding many markets. This
 * adapter reads the three every book quotes: the moneyline, the spreads
 * and the totals, full game. Each market is a pair of outcome tokens; the
 * price of backing one is that token's best ask, so the decimal odds are
 * 1 / ask, the same unit as a sportsbook price.
 *
 * Two shapes of moneyline exist. American leagues list one market whose
 * outcomes are the two teams. Soccer lists three yes/no markets — home,
 * draw, away — and the YES token of each is the outcome.
 *
 * ### Two paths, both public and unauthenticated
 *
 * - **Polling** reads Gamma's `/events?series_id=…`, one request per page of
 *   a league's upcoming games.
 * - **Streaming** holds the CLOB market channel open. Each `price_change`
 *   carries the new best bid and ask per token, so a move lands in
 *   milliseconds. The channel wants a `PING` text frame every ten seconds.
 *
 * Game identity comes from ESPN, matched on the teams' abbreviations and
 * the date (see `exchange-games.ts`), so "Spurs" lands on the same event as
 * DraftKings' "San Antonio Spurs".
 */

const GAMMA = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com'
const WS = process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

/** Our sport slug (also the ESPN league key) to Polymarket's sport code. */
export const LEAGUES: Record<string, string> = {
  nfl: 'nfl',
  nba: 'nba',
  mlb: 'mlb',
  nhl: 'nhl',
  ncaaf: 'cfb',
  ncaab: 'cbb',
  epl: 'epl',
  laliga: 'lal',
  seriea: 'sea',
  bundesliga: 'bun',
  ligue1: 'fl1',
  ucl: 'ucl',
}

const MARKET_TYPES = new Set(['moneyline', 'spreads', 'totals'])

/** The fields of a Gamma market this adapter reads. */
export interface GammaMarket {
  question?: string
  sportsMarketType?: string
  groupItemTitle?: string
  outcomes?: string
  clobTokenIds?: string
  bestBid?: number | null
  bestAsk?: number | null
  line?: number | null
  volumeNum?: number | null
  active?: boolean
  closed?: boolean
  acceptingOrders?: boolean
}

export interface GammaTeam {
  name: string
  abbreviation?: string
  ordering?: string
}

/** The fields of a Gamma event this adapter reads. */
export interface GammaEvent {
  id: string
  slug?: string
  eventDate?: string
  startTime?: string
  ended?: boolean
  closed?: boolean
  teams?: GammaTeam[]
  markets?: GammaMarket[]
}

/** One outcome token as last quoted. */
interface TokenState {
  token: string
  side: string
  label: string
  point: number | null
  /** Share prices for this token. */
  bid: number | null
  ask: number | null
  volume: number
}

/** One market (one line) of one game. */
interface MarketState {
  marketType: string
  line: number | null
  tokens: TokenState[]
}

/** One game as last quoted. */
interface GameState {
  externalId: string
  sportSlug: string
  commenceAt: string
  homeTeam: string
  awayTeam: string
  markets: MarketState[]
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(String)
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  }
  catch {
    return []
  }
}

function tradable(market: GammaMarket): boolean {
  return market.active !== false && market.closed !== true && market.acceptingOrders !== false
}

/**
 * Turn one league's Gamma events into feed events.
 *
 * Pure: the ESPN games are passed in, so a recorded payload and a recorded
 * scoreboard pin the whole translation in a test.
 */
export function translate(events: GammaEvent[], sportSlug: string, gamesByDate: Map<string, Game[]>, now = new Date()): FeedEvent[] {
  return toGameStates(events, sportSlug, gamesByDate).flatMap((state) => {
    const event = toFeedEvent(state, now)
    return event ? [event] : []
  })
}

function toGameStates(events: GammaEvent[], sportSlug: string, gamesByDate: Map<string, Game[]>): GameState[] {
  const states: GameState[] = []
  for (const event of events) {
    if (event.ended || event.closed)
      continue
    const home = event.teams?.find(team => team.ordering === 'home')
    const away = event.teams?.find(team => team.ordering === 'away')
    const date = String(event.eventDate ?? '').replace(/-/g, '')
    if (!home || !away || !/^\d{8}$/.test(date))
      continue

    const game = findGame(sportSlug, date, `${away.abbreviation ?? ''}${home.abbreviation ?? ''}`, gamesByDate.get(date) ?? [], [home.name, away.name])
    if (!game || game.state === 'post')
      continue

    // Which ESPN side each Polymarket team is, by Polymarket's own
    // ordering: the code match above already confirmed it is this game.
    const sideOfName = (name: string): 'home' | 'away' | null => {
      const wanted = name.trim().toLowerCase()
      if (wanted === home.name.trim().toLowerCase())
        return 'home'
      if (wanted === away.name.trim().toLowerCase())
        return 'away'
      return null
    }
    const labelOf = (side: string) => side === 'home' ? game.home.name : (side === 'away' ? game.away.name : 'Draw')

    const state: GameState = {
      externalId: String(event.id),
      sportSlug,
      // ESPN writes `2026-11-18T01:00Z`; the full form is what the rest of
      // the table stores and what the event matcher compares against.
      commenceAt: new Date(game.startsAt).toISOString(),
      homeTeam: game.home.name,
      awayTeam: game.away.name,
      markets: [],
    }

    // Soccer's three yes/no moneylines fold into one three-way market.
    const threeWay: TokenState[] = []

    for (const market of event.markets ?? []) {
      const type = market.sportsMarketType ?? ''
      if (!MARKET_TYPES.has(type) || !tradable(market))
        continue
      const outcomes = parseList(market.outcomes)
      const tokens = parseList(market.clobTokenIds)
      if (outcomes.length !== 2 || tokens.length !== 2)
        continue
      const volume = Number(market.volumeNum ?? 0) || 0
      // Gamma's best bid and ask are for the first token; the second
      // token's quote is their complement.
      const firstBid = share(market.bestBid)
      const firstAsk = share(market.bestAsk)
      const first = { bid: firstBid, ask: firstAsk }
      const second = { bid: firstAsk === null ? null : share(1 - firstAsk), ask: firstBid === null ? null : share(1 - firstBid) }

      if (type === 'moneyline' && outcomes[0]!.toLowerCase() === 'yes') {
        const title = String(market.groupItemTitle ?? '')
        const side = /^draw\b/i.test(title) ? 'draw' : sideOfName(title)
        if (side)
          threeWay.push({ token: tokens[0]!, side, label: labelOf(side), point: null, ...first, volume })
        continue
      }

      if (type === 'totals') {
        const line = typeof market.line === 'number' ? market.line : null
        if (line === null)
          continue
        state.markets.push({
          marketType: 'totals',
          line,
          tokens: outcomes.map((label, index) => ({
            token: tokens[index]!,
            side: label.toLowerCase() === 'over' ? 'over' : 'under',
            label: label.toLowerCase() === 'over' ? 'Over' : 'Under',
            point: line,
            ...(index === 0 ? first : second),
            volume,
          })),
        })
        continue
      }

      const firstSide = sideOfName(outcomes[0]!)
      const secondSide = sideOfName(outcomes[1]!)
      if (!firstSide || !secondSide || firstSide === secondSide)
        continue

      if (type === 'moneyline') {
        state.markets.push({
          marketType: 'h2h',
          line: null,
          tokens: [
            { token: tokens[0]!, side: firstSide, label: labelOf(firstSide), point: null, ...first, volume },
            { token: tokens[1]!, side: secondSide, label: labelOf(secondSide), point: null, ...second, volume },
          ],
        })
        continue
      }

      // Spreads: Gamma's line is the first outcome's handicap. Ours is the
      // home team's, signed, with each side carrying its own point.
      const line = typeof market.line === 'number' ? market.line : null
      if (line === null)
        continue
      state.markets.push({
        marketType: 'spreads',
        line: firstSide === 'home' ? line : -line,
        tokens: [
          { token: tokens[0]!, side: firstSide, label: labelOf(firstSide), point: line, ...first, volume },
          { token: tokens[1]!, side: secondSide, label: labelOf(secondSide), point: -line, ...second, volume },
        ],
      })
    }

    if (threeWay.length >= 2)
      state.markets.push({ marketType: 'h2h', line: null, tokens: threeWay })

    if (state.markets.length > 0)
      states.push(state)
  }
  return states
}

function toFeedEvent(state: GameState, now: Date): FeedEvent | null {
  const markets: FeedMarket[] = []
  for (const market of state.markets) {
    const outcomes: FeedOutcome[] = market.tokens.flatMap((token) => {
      const price = quotable(token.bid, token.ask)
      return price === null
        ? []
        : [{ side: token.side, label: token.label, point: token.point, price, sid: token.token, tradedVolume: token.volume }]
    })
    if (outcomes.length >= 2)
      markets.push({ marketType: market.marketType, line: market.line, outcomes })
  }
  if (markets.length === 0)
    return null
  return {
    externalId: state.externalId,
    sportSlug: state.sportSlug,
    commenceAt: state.commenceAt,
    homeTeam: state.homeTeam,
    awayTeam: state.awayTeam,
    books: [{ key: 'polymarket', title: 'Polymarket', lastUpdate: now.toISOString(), markets }],
  }
}

/** Polymarket's series id for a sport code, from its own `/sports` list. */
let seriesIds: { at: number, ids: Map<string, string> } | null = null
async function seriesFor(code: string, get: (url: string) => Promise<Response | null>): Promise<string | null> {
  if (!seriesIds || Date.now() - seriesIds.at > 3_600_000) {
    const response = await get(`${GAMMA}/sports`)
    if (response?.ok) {
      const sports = await response.json() as Array<{ sport?: string, series?: string }>
      seriesIds = { at: Date.now(), ids: new Map(sports.flatMap(s => s.sport && s.series ? [[s.sport, String(s.series)]] : [])) }
    }
  }
  return seriesIds?.ids.get(code) ?? null
}

/** One league's upcoming and live games. */
async function fetchLeague(sportSlug: string, get: (url: string) => Promise<Response | null>): Promise<GammaEvent[] | null> {
  const code = LEAGUES[sportSlug]
  const series = code ? await seriesFor(code, get) : null
  if (!series)
    return code ? null : []
  // Games that started within the last eight hours may still be live.
  const since = new Date(Date.now() - 8 * 3_600_000).toISOString().slice(0, 19) + 'Z'
  const events: GammaEvent[] = []
  for (let offset = 0; offset < 400; offset += 50) {
    const response = await get(`${GAMMA}/events?series_id=${series}&closed=false&end_date_min=${since}&limit=50&offset=${offset}`)
    if (!response?.ok)
      return offset === 0 ? null : events
    const page = await response.json() as GammaEvent[]
    if (!Array.isArray(page))
      return offset === 0 ? null : events
    events.push(...page)
    if (page.length < 50)
      break
  }
  return events
}

async function loadLeague(sportSlug: string, get: (url: string) => Promise<Response | null>, games = gamesForDates): Promise<GameState[] | null> {
  const listed = await fetchLeague(sportSlug, get)
  if (!listed)
    return null
  // Only games near enough to price; see `nearDate`.
  const events = listed.filter(event => nearDate(String(event.eventDate ?? '').replace(/-/g, '')))
  const dates = events.map(event => String(event.eventDate ?? '').replace(/-/g, '')).filter(date => /^\d{8}$/.test(date))
  return toGameStates(events, sportSlug, await games(sportSlug, dates))
}

// ---- Streaming ---------------------------------------------------------

/** A market-channel message, as Polymarket sent it. */
export interface PolymarketMessage {
  event_type?: string
  asset_id?: string
  best_bid?: string
  best_ask?: string
  bids?: Array<{ price: string, size: string }>
  asks?: Array<{ price: string, size: string }>
  price_changes?: Array<{ asset_id: string, best_bid?: string, best_ask?: string }>
  timestamp?: string
}

/** Where each token sits, so a tick finds its game in one lookup. */
type TokenIndex = Map<string, { game: GameState, token: TokenState }>

/** A token's top of book, as one message reports it. */
export interface TokenQuote {
  token: string
  bid: number | null
  ask: number | null
}

/** The best bid and ask per token a message reports. */
export function quotesFrom(message: PolymarketMessage): TokenQuote[] {
  switch (message.event_type) {
    case 'price_change':
      return (message.price_changes ?? []).map(change => ({ token: change.asset_id, bid: share(change.best_bid), ask: share(change.best_ask) }))
    case 'best_bid_ask':
      return message.asset_id ? [{ token: message.asset_id, bid: share(message.best_bid), ask: share(message.best_ask) }] : []
    case 'book': {
      // Levels arrive in no promised order: the best bid is the highest,
      // the best ask the lowest.
      const levels = (side?: Array<{ price: string }>) => (side ?? []).map(level => Number.parseFloat(level.price)).filter(Number.isFinite)
      const bids = levels(message.bids)
      const asks = levels(message.asks)
      return message.asset_id
        ? [{ token: message.asset_id, bid: bids.length ? share(Math.max(...bids)) : null, ask: asks.length ? share(Math.min(...asks)) : null }]
        : []
    }
    default:
      return []
  }
}

/** Apply one message, returning the games whose prices changed. */
export function applyMessage(index: TokenIndex, message: PolymarketMessage): GameState[] {
  const changed = new Set<GameState>()
  for (const quote of quotesFrom(message)) {
    const hit = index.get(quote.token)
    if (!hit || (quote.bid === hit.token.bid && quote.ask === hit.token.ask))
      continue
    hit.token.bid = quote.bid
    hit.token.ask = quote.ask
    changed.add(hit.game)
  }
  return [...changed]
}

const DISCOVERY_MS = 60_000

class PolymarketStream {
  private socket: WebSocket | null = null
  private readonly games = new Map<string, GameState>()
  private index: TokenIndex = new Map()
  private subscribed = new Set<string>()
  private stopped = false
  private attempts = 0
  private discovery: ReturnType<typeof setInterval> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  lastMessageAt = 0

  constructor(private readonly ctx: BookContext, private readonly onChange: (event: FeedEvent) => void) {}

  healthy(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < 120_000
  }

  async start(): Promise<void> {
    // Connect first; discovery subscribes to games as it finds them.
    this.connect()
    await this.discover()
    this.discovery = setInterval(() => { void this.discover() }, DISCOVERY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.discovery)
      clearInterval(this.discovery)
    if (this.ping)
      clearInterval(this.ping)
    this.socket?.close()
    this.socket = null
  }

  private async discover(): Promise<void> {
    const get = (url: string) => this.ctx.fetch(url)
    const seen = new Set<string>()
    for (const sportSlug of Object.keys(LEAGUES)) {
      const states = await loadLeague(sportSlug, get).catch(() => null)
      if (!states)
        continue
      for (const state of states) {
        if (!streamable(state.commenceAt))
          continue
        seen.add(state.externalId)
        const known = this.games.get(state.externalId)
        if (!known) {
          this.games.set(state.externalId, state)
          continue
        }
        // Keep streamed quotes for tokens already carried; take new lines.
        const quotes = new Map(known.markets.flatMap(market => market.tokens.map(token => [token.token, token] as const)))
        for (const market of state.markets) {
          for (const token of market.tokens) {
            const live = quotes.get(token.token)
            if (live) {
              token.bid = live.bid
              token.ask = live.ask
            }
          }
        }
        this.games.set(state.externalId, state)
      }
      // Subscribe league by league rather than after all twelve.
      this.reindex()
    }
    for (const id of [...this.games.keys()]) {
      if (!seen.has(id))
        this.games.delete(id)
    }
    this.reindex()
  }

  private reindex(): void {
    this.index = new Map([...this.games.values()].flatMap(game => game.markets.flatMap(market => market.tokens.map(token => [token.token, { game, token }] as const))))
    this.syncSubscription()
  }

  private syncSubscription(): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return
    const added = [...this.index.keys()].filter(token => !this.subscribed.has(token))
    if (added.length === 0)
      return
    const first = this.subscribed.size === 0
    this.socket.send(JSON.stringify(first
      ? { assets_ids: added, type: 'market', custom_feature_enabled: true }
      : { assets_ids: added, operation: 'subscribe', custom_feature_enabled: true }))
    for (const token of added)
      this.subscribed.add(token)
  }

  private connect(): void {
    if (this.stopped)
      return
    this.subscribed = new Set()
    const socket = new WebSocket(WS)
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.lastMessageAt = Date.now()
      this.syncSubscription()
      log.info(`[odds] polymarket stream connected, ${this.index.size} tokens across ${this.games.size} games`)
      if (this.ping)
        clearInterval(this.ping)
      this.ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send('PING')
      }, 10_000)
    }

    socket.onmessage = (frame) => {
      this.lastMessageAt = Date.now()
      const text = String(frame.data)
      if (text === 'PONG')
        return
      let parsed: PolymarketMessage | PolymarketMessage[]
      try {
        parsed = JSON.parse(text)
      }
      catch {
        return
      }
      const changed = new Set<GameState>()
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        for (const game of applyMessage(this.index, message))
          changed.add(game)
      }
      const now = new Date()
      for (const game of changed) {
        const event = toFeedEvent(game, now)
        if (event)
          this.onChange(event)
      }
    }

    socket.onclose = () => {
      if (this.ping)
        clearInterval(this.ping)
      if (this.stopped)
        return
      const delay = Math.min(60_000, 1000 * 2 ** this.attempts++)
      setTimeout(() => this.connect(), delay)
    }

    socket.onerror = () => {}
  }
}

let stream: PolymarketStream | null = null

export const polymarket: BookAdapter = {
  slug: 'polymarket',
  kind: 'exchange',
  transport: 'websocket',
  sports: Object.keys(LEAGUES),

  async fetchSport(sport: SportRow, ctx: BookContext): Promise<FeedEvent[]> {
    if (stream?.healthy())
      return []

    const states = await loadLeague(sport.slug, url => ctx.fetch(url))
    if (states === null) {
      ctx.tracker.fail(`polymarket: ${sport.slug} events unavailable`)
      return []
    }
    // The same near-term window the stream carries. Games days out barely
    // move, and listing all of them makes every pass a heavy write.
    const now = new Date()
    return states.filter(state => streamable(state.commenceAt, now.getTime())).flatMap((state) => {
      const event = toFeedEvent(state, now)
      return event ? [event] : []
    })
  },

  subscribe(ctx: BookContext, onChange: (event: FeedEvent) => void): Subscription {
    stream = new PolymarketStream(ctx, onChange)
    void stream.start().catch((error) => {
      log.warn(`[odds] polymarket stream failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
    return {
      close: () => {
        stream?.stop()
        stream = null
      },
    }
  },
}
