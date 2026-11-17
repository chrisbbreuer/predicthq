import type { SportRow } from '../../ingest/resolve'
import type { Game } from '../../scores/espn'
import type { KalshiCredentials } from '../../trading/credentials'
import type { FeedEvent, FeedOutcome } from '../provider'
import type { BookAdapter, BookContext, Subscription } from './adapter'
import { createSign } from 'node:crypto'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Database } from '../../../Support/db'
import { openCredentials } from '../../trading/credentials'
import { parseGameTicker, sideForOutcome } from '../../trading/live-games'
import { findGame, gamesForDates, quotable, share, streamable } from './exchange-games'

/**
 * Kalshi, as a book.
 *
 * Kalshi lists one market per outcome of a game — "Boston wins", "Orlando
 * wins", and for soccer "Tie" — each a YES share between $0 and $1. The
 * price of backing an outcome is the YES ask, so the decimal odds on it
 * are 1 / ask. That is the same unit every sportsbook price is stored in,
 * which is what lets the board put Kalshi beside DraftKings.
 *
 * ### Two paths, both public data
 *
 * - **Polling** reads `GET /markets?series_ticker=…`, unauthenticated, one
 *   request per league however many games it lists.
 * - **Streaming** holds Kalshi's WebSocket open on the `ticker` channel.
 *   Kalshi requires a signed handshake even for public channels, so the
 *   stream uses the operator's own API key (`KALSHI_STREAM_KEY_ID` and
 *   `KALSHI_STREAM_PRIVATE_KEY`, or the first connected Kalshi account).
 *   Without one the league simply stays on polling.
 *
 * ### Game identity comes from ESPN
 *
 * See `exchange-games.ts`: the event ticker carries both teams' codes and
 * the date, which pins the ESPN game and with it the canonical names and
 * the real start time. A game ESPN cannot place is skipped rather than
 * guessed at.
 *
 * Winner markets only for now. Kalshi's spreads and totals are separate
 * series with a different shape and land in a later pass.
 */

const REST = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'
const WS = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2'

/** Our sport slug (also the ESPN league key) to Kalshi's game-winner series. */
export const SERIES: Record<string, string> = {
  'nfl': 'KXNFLGAME',
  'nba': 'KXNBAGAME',
  'mlb': 'KXMLBGAME',
  'nhl': 'KXNHLGAME',
  'ncaaf': 'KXNCAAFGAME',
  'ncaab': 'KXNCAAMBGAME',
  'epl': 'KXEPLGAME',
  'laliga': 'KXLALIGAGAME',
  'seriea': 'KXSERIEAGAME',
  'bundesliga': 'KXBUNDESLIGAGAME',
  'ligue1': 'KXLIGUE1GAME',
  'ucl': 'KXUCLGAME',
  'uefa-nations': 'KXUEFANLGAME',
}

/** The fields of a Kalshi market this adapter reads. */
export interface KalshiRawMarket {
  ticker: string
  event_ticker: string
  status?: string
  yes_sub_title?: string
  yes_bid_dollars?: string | null
  yes_ask_dollars?: string | null
  volume_fp?: string | null
}

/** One outcome as last quoted, kept so a stream tick can rebuild its game. */
interface OutcomeState {
  ticker: string
  side: string
  label: string
  /** YES share prices. */
  bid: number | null
  ask: number | null
  volume: number
}

/** One game as last quoted. */
interface GameState {
  eventTicker: string
  sportSlug: string
  commenceAt: string
  homeTeam: string
  awayTeam: string
  outcomes: Map<string, OutcomeState>
}

/**
 * Turn one league's open markets into feed events.
 *
 * Pure: the ESPN games are passed in, so a recorded payload and a
 * recorded scoreboard pin the whole translation in a test.
 */
export function translate(markets: KalshiRawMarket[], sportSlug: string, gamesByDate: Map<string, Game[]>, now = new Date()): FeedEvent[] {
  return toGameStates(markets, sportSlug, gamesByDate).flatMap((state) => {
    const event = toFeedEvent(state, now)
    return event ? [event] : []
  })
}

function toGameStates(markets: KalshiRawMarket[], sportSlug: string, gamesByDate: Map<string, Game[]>): GameState[] {
  const byEvent = new Map<string, KalshiRawMarket[]>()
  for (const market of markets) {
    if (market.status && market.status !== 'active')
      continue
    const list = byEvent.get(market.event_ticker) ?? []
    list.push(market)
    byEvent.set(market.event_ticker, list)
  }

  const states: GameState[] = []
  for (const [eventTicker, outcomes] of byEvent) {
    const ref = parseGameTicker(outcomes[0]!.ticker)
    if (!ref)
      continue

    const hints = outcomes.map(outcome => outcome.yes_sub_title ?? '').filter(Boolean)
    const game = findGame(ref.league, ref.date, ref.code, gamesByDate.get(ref.date) ?? [], hints)
    // A finished game has nothing left to price, and one ESPN cannot place
    // would have to be guessed at.
    if (!game || game.state === 'post')
      continue

    const state: GameState = {
      eventTicker,
      sportSlug,
      commenceAt: game.startsAt,
      homeTeam: game.home.name,
      awayTeam: game.away.name,
      outcomes: new Map(),
    }

    for (const market of outcomes) {
      const suffix = market.ticker.split('-').at(-1) ?? ''
      const side = suffix.toUpperCase() === 'TIE'
        ? 'draw'
        : sideForOutcome(suffix, game, market.yes_sub_title ?? '')
      if (!side)
        continue

      state.outcomes.set(market.ticker, {
        ticker: market.ticker,
        side,
        label: side === 'draw' ? 'Draw' : (side === 'home' ? game.home.name : game.away.name),
        bid: share(market.yes_bid_dollars),
        ask: share(market.yes_ask_dollars),
        volume: Number.parseFloat(String(market.volume_fp ?? '0')) || 0,
      })
    }

    if (state.outcomes.size >= 2)
      states.push(state)
  }
  return states
}

function toFeedEvent(state: GameState, now: Date): FeedEvent | null {
  const outcomes: FeedOutcome[] = []
  for (const outcome of state.outcomes.values()) {
    const price = quotable(outcome.bid, outcome.ask)
    if (price === null)
      continue
    outcomes.push({
      side: outcome.side,
      label: outcome.label,
      point: null,
      price,
      sid: outcome.ticker,
      tradedVolume: outcome.volume,
    })
  }
  // One side alone is not a market: there is nothing to compare it with.
  if (outcomes.length < 2)
    return null

  return {
    externalId: state.eventTicker,
    sportSlug: state.sportSlug,
    commenceAt: state.commenceAt,
    homeTeam: state.homeTeam,
    awayTeam: state.awayTeam,
    books: [{
      key: 'kalshi',
      title: 'Kalshi',
      lastUpdate: now.toISOString(),
      markets: [{ marketType: 'h2h', line: null, outcomes }],
    }],
  }
}

/** Every open market in one series, following Kalshi's cursor. */
async function fetchSeries(series: string, get: (url: string) => Promise<Response | null>): Promise<KalshiRawMarket[] | null> {
  const markets: KalshiRawMarket[] = []
  let cursor = ''
  for (let page = 0; page < 5; page++) {
    const response = await get(`${REST}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!response?.ok)
      return page === 0 ? null : markets
    const body = await response.json() as { markets?: KalshiRawMarket[], cursor?: string }
    markets.push(...(body.markets ?? []))
    cursor = body.cursor ?? ''
    if (!cursor || !body.markets?.length)
      break
  }
  return markets
}

/** One league, translated, with the game states kept for the stream. */
async function loadLeague(sportSlug: string, get: (url: string) => Promise<Response | null>, games = gamesForDates): Promise<GameState[] | null> {
  const series = SERIES[sportSlug]
  if (!series)
    return []
  const markets = await fetchSeries(series, get)
  if (!markets)
    return null
  const dates = markets.flatMap((market) => {
    const ref = parseGameTicker(market.ticker)
    return ref ? [ref.date] : []
  })
  return toGameStates(markets, sportSlug, await games(sportSlug, dates))
}

// ---- Streaming ---------------------------------------------------------

/** The key the stream signs its handshake with, or null when there is none. */
async function streamCredentials(): Promise<KalshiCredentials | null> {
  const keyId = process.env.KALSHI_STREAM_KEY_ID?.trim()
  const pem = process.env.KALSHI_STREAM_PRIVATE_KEY?.trim()
  if (keyId && pem)
    return { venue: 'kalshi', apiKeyId: keyId, privateKeyPem: pem.replace(/\\n/g, '\n') }

  const db = new Database()
  try {
    const row = await db.prepare<{ credentials: string }>(
      `SELECT credentials FROM exchange_accounts WHERE venue = 'kalshi' AND status = 'active' ORDER BY id LIMIT 1`,
    ).get()
    if (!row)
      return null
    const credentials = await openCredentials(row.credentials)
    return credentials.venue === 'kalshi' ? credentials : null
  }
  catch {
    return null
  }
}

function handshakeHeaders(credentials: KalshiCredentials): Record<string, string> {
  const timestamp = String(Date.now())
  const signer = createSign('RSA-SHA256')
  signer.update(`${timestamp}GET/trade-api/ws/v2`)
  signer.end()
  return {
    'KALSHI-ACCESS-KEY': credentials.apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': signer.sign({ key: credentials.privateKeyPem, padding: 6, saltLength: 32 }, 'base64'),
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
  }
}

/** A `ticker` message, as Kalshi sent it. */
export interface KalshiTickerMessage {
  type: string
  sid?: number
  msg?: {
    market_ticker?: string
    yes_ask_dollars?: string
    yes_bid_dollars?: string
    volume_fp?: string
    ts_ms?: number
  }
}

/**
 * Apply one ticker message to the known games, returning the game that
 * changed or null when the message moved nothing we carry.
 */
export function applyTicker(games: Map<string, GameState>, message: KalshiTickerMessage): GameState | null {
  const ticker = message.msg?.market_ticker
  if (message.type !== 'ticker' || !ticker)
    return null
  const eventTicker = ticker.split('-').slice(0, 2).join('-')
  const game = games.get(eventTicker)
  const outcome = game?.outcomes.get(ticker)
  if (!game || !outcome)
    return null

  const ask = share(message.msg?.yes_ask_dollars)
  const bid = share(message.msg?.yes_bid_dollars)
  const volume = Number.parseFloat(String(message.msg?.volume_fp ?? '')) || outcome.volume
  if (ask === outcome.ask && bid === outcome.bid && volume === outcome.volume)
    return null
  outcome.ask = ask
  outcome.bid = bid
  outcome.volume = volume
  return game
}

/** How often the stream re-reads every league for games that have just listed. */
const DISCOVERY_MS = 60_000

class KalshiStream {
  private socket: WebSocket | null = null
  private readonly games = new Map<string, GameState>()
  private subscribed = new Set<string>()
  private sid: number | null = null
  private commandId = 0
  private stopped = false
  private attempts = 0
  private discovery: ReturnType<typeof setInterval> | null = null
  lastMessageAt = 0

  constructor(
    private readonly credentials: KalshiCredentials,
    private readonly ctx: BookContext,
    private readonly onChange: (event: FeedEvent) => void,
  ) {}

  /** Healthy means connected and hearing from Kalshi recently. */
  healthy(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < 120_000
  }

  async start(): Promise<void> {
    await this.discover()
    this.connect()
    this.discovery = setInterval(() => { void this.discover() }, DISCOVERY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.discovery)
      clearInterval(this.discovery)
    this.socket?.close()
    this.socket = null
  }

  /** Re-read every league and subscribe to any market not yet on the socket. */
  private async discover(): Promise<void> {
    const get = (url: string) => this.ctx.fetch(url)
    const seen = new Set<string>()
    for (const sportSlug of Object.keys(SERIES)) {
      const states = await loadLeague(sportSlug, get).catch(() => null)
      if (!states)
        continue
      for (const state of states) {
        if (!streamable(state.commenceAt))
          continue
        seen.add(state.eventTicker)
        const known = this.games.get(state.eventTicker)
        // Keep the live quote: discovery reads REST, which can lag the socket.
        if (known) {
          for (const [ticker, outcome] of state.outcomes) {
            if (!known.outcomes.has(ticker))
              known.outcomes.set(ticker, outcome)
          }
          known.commenceAt = state.commenceAt
        }
        else {
          this.games.set(state.eventTicker, state)
        }
      }
    }
    // Games that dropped off the open list have settled; stop carrying them.
    for (const eventTicker of [...this.games.keys()]) {
      if (!seen.has(eventTicker))
        this.games.delete(eventTicker)
    }
    this.syncSubscription()
  }

  private tickers(): string[] {
    return [...this.games.values()].flatMap(game => [...game.outcomes.keys()])
  }

  private send(cmd: string, params: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return
    this.socket.send(JSON.stringify({ id: ++this.commandId, cmd, params }))
  }

  /** Subscribe once, then grow the subscription as games list. */
  private syncSubscription(): void {
    const wanted = this.tickers()
    if (wanted.length === 0)
      return
    if (this.sid === null) {
      this.send('subscribe', { channels: ['ticker'], market_tickers: wanted })
      this.subscribed = new Set(wanted)
      return
    }
    const added = wanted.filter(ticker => !this.subscribed.has(ticker))
    if (added.length === 0)
      return
    this.send('update_subscription', { sids: [this.sid], market_tickers: added, action: 'add_markets' })
    for (const ticker of added)
      this.subscribed.add(ticker)
  }

  private connect(): void {
    if (this.stopped)
      return
    this.sid = null
    // Bun's WebSocket takes handshake headers as a non-standard option.
    const socket = new WebSocket(WS, { headers: handshakeHeaders(this.credentials) } as unknown as string[])
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.lastMessageAt = Date.now()
      this.syncSubscription()
    }

    socket.onmessage = (frame) => {
      this.lastMessageAt = Date.now()
      let message: KalshiTickerMessage & { msg?: { sid?: number, code?: number } }
      try {
        message = JSON.parse(String(frame.data))
      }
      catch {
        return
      }
      if (message.type === 'subscribed') {
        this.sid = message.msg?.sid ?? null
        return
      }
      if (message.type === 'error') {
        // A rejected command leaves the socket in an unknown state; a clean
        // reconnect resubscribes to the full list.
        log.warn(`[odds] kalshi stream: ${JSON.stringify(message.msg)}`)
        socket.close()
        return
      }
      const game = applyTicker(this.games, message)
      if (!game)
        return
      const event = toFeedEvent(game, new Date(message.msg?.ts_ms ?? Date.now()))
      if (event)
        this.onChange(event)
    }

    socket.onclose = () => {
      if (this.stopped)
        return
      // Exponential backoff to a minute: Kalshi rate limits handshakes.
      const delay = Math.min(60_000, 1000 * 2 ** this.attempts++)
      setTimeout(() => this.connect(), delay)
    }

    socket.onerror = () => {
      // `onclose` follows and schedules the reconnect.
    }
  }
}

let stream: KalshiStream | null = null

export const kalshi: BookAdapter = {
  slug: 'kalshi',
  kind: 'exchange',
  transport: 'websocket',
  sports: Object.keys(SERIES),

  async fetchSport(sport: SportRow, ctx: BookContext): Promise<FeedEvent[]> {
    // The socket already delivers every change for the games it carries,
    // and it discovers new ones on its own; polling would only repeat it.
    if (stream?.healthy())
      return []

    const states = await loadLeague(sport.slug, url => ctx.fetch(url))
    if (states === null) {
      ctx.tracker.fail(`kalshi: ${sport.slug} markets unavailable`)
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
    let closed = false
    void streamCredentials().then((credentials) => {
      if (closed)
        return
      if (!credentials) {
        log.info('[odds] kalshi: no API key for the stream, staying on polling')
        return
      }
      stream = new KalshiStream(credentials, ctx, onChange)
      void stream.start()
    })
    return {
      close: () => {
        closed = true
        stream?.stop()
        stream = null
      },
    }
  },
}
