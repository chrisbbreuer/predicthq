import type { Database } from '../../Support/db'
import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { LiveGame } from './live-games'
import type { OddsPapiQuote } from './oddspapi-checkpoints'
import type { AuditGame } from './prediction-audit'
import type { WinnerContext } from './winner-context'
import { kalshiMarkets } from '../prediction-markets/kalshi-public'
import { parseGameTicker } from './live-games'
import { saveOddsPapiQuotes } from './oddspapi-checkpoints'
import { predictionAudit, prospectiveSportsbookAudit, prospectiveWinnerAudit, rankCapturedWinners } from './prediction-audit'
import { matchEvent } from './sportsbook-consensus'
import { captureWinnerContext, utcTime } from './winner-context'
import frozenWinnerContext from './winner-context-fit.json'
import outcomeWinnerContext from './winner-context-outcomes.json'

export const winnerCheckpointLeagues = new Set(['nba', 'wnba', 'nhl', 'nfl', 'ncaaf', 'ncaab', 'ncaaw', 'mlb'])
const maxAgeMs = 10 * 60_000
export const MIN_PAIRED_CHECKPOINTS = 50

interface QuoteRow {
  bookmaker: string
  side: string
  price: number | string
  observed_at: string
  updated_at: string
  source?: string
}

export function groupSportsbookQuotes(rows: QuoteRow[], at: number) {
  const byBook = new Map<string, QuoteRow[]>()
  for (const row of rows) {
    const quotes = byBook.get(row.bookmaker) ?? []
    quotes.push(row)
    byBook.set(row.bookmaker, quotes)
  }
  return [...byBook].flatMap(([book, quotes]) => {
    const home = quotes.find(q => q.side === 'home')
    const away = quotes.find(q => q.side === 'away')
    if (quotes.length !== 2 || !home || !away)
      return []
    const age = quotes.map(q => at - utcTime(q.updated_at))
    const prices = quotes.map(q => Number(q.price))
    if (age.some(ms => !Number.isFinite(ms) || ms < 0 || ms > maxAgeMs) || prices.some(p => !Number.isFinite(p) || p <= 1))
      return []
    const total = 1 / Number(home.price) + 1 / Number(away.price)
    if (total < 0.98 || total > 1.15)
      return []
    return [{ book, home, away, probability: 1 / Number(home.price) / total }]
  })
}

function inWindow(start: number, at: number): boolean {
  return start - at >= 30 * 60_000 && start - at <= 40 * 60_000
}

export function winnerCheckpointDue(ticker: string, game: LiveGame, at: number): boolean {
  const startsAt = utcTime(game.startsAt)
  return game.state === 'pre' && game.selected === 'home' && winnerCheckpointLeagues.has(game.league)
    && parseGameTicker(ticker)?.winner === true && inWindow(startsAt, at)
}

/** Freeze newly checked Kalshi quotes and complete sportsbook pairs
 * from the live odds table, whose ingestion refreshes updated_at even
 * on unchanged prices. Nothing is taken from the historical change log.
 */
export async function capturePredictionCheckpoint(
  db: Database,
  ticker: string,
  game: LiveGame,
  now = Date.now,
  loadMarket = async (ticker: string) => (await kalshiMarkets([ticker], 0)).get(ticker),
  externalQuotes: OddsPapiQuote[] = [],
): Promise<{ captured: number, paired: number, oddsPapiObservations?: number }> {
  const none = { captured: 0, paired: 0 }
  const start = Date.parse(game.startsAt)
  const ref = parseGameTicker(ticker)
  if (!ref || !winnerCheckpointDue(ticker, game, now()))
    return none
  const eventId = await matchEvent(db, game)
  const books = eventId === null ? [] : await db.query<QuoteRow>(`
    SELECT b.slug AS bookmaker, s.side, o.price, o.observed_at, o.updated_at
    FROM markets m
    JOIN selections s ON s.market_id = m.id
    JOIN odds o ON o.selection_id = s.id
    JOIN bookmakers b ON b.id = o.bookmaker_id
    WHERE m.market_event_id = ? AND m.market_type = 'h2h' AND m.period = 'full_game'
      AND o.available = 1 AND b.kind = 'sportsbook' AND b.slug NOT IN ('kalshi', 'polymarket', 'betfair', 'smarkets', 'matchbook')
    ORDER BY b.slug, s.side
  `).all(eventId)
  const quote = await loadMarket(ticker).catch(() => undefined)
  const at = now()
  if (!inWindow(start, at))
    return none
  const active = quote && ['open', 'active'].includes(quote.status)
  const bid = active ? quote.yesBid : null
  const ask = active ? quote.yesAsk : null
  // Keep the venue's response for coverage auditing even if it has no
  // executable quote. Such captures are never scored or ranked.
  const usable = bid !== null && ask !== null && bid > 0 && ask < 1 && ask >= bid && ask - bid <= 0.100000001
  const freshOddsPapi = externalQuotes.filter(quote => inWindow(start, utcTime(quote.updated_at)) && utcTime(quote.updated_at) <= at)
  const observationsByBook = new Map(groupSportsbookQuotes(books, at).map(observation => [observation.book, observation]))
  for (const observation of groupSportsbookQuotes(freshOddsPapi, at))
    observationsByBook.set(observation.book, observation)
  const observations = [...observationsByBook.values()]
  const consensus = observations.length >= 2
    ? observations.reduce((sum, book) => sum + book.probability, 0) / observations.length
    : null
  const context = eventId === null ? null : await captureWinnerContext(db, eventId, game.league, start, at)
  const checkpoint = {
    event_ticker: ref.eventTicker,
    ticker,
    league: game.league,
    start_at: new Date(start).toISOString(),
    captured_at: new Date(at).toISOString(),
    payload: JSON.stringify({ bid, ask, usable, kalshiStatus: quote?.status ?? null, observations, consensus, context, oddsPapiQuotes: freshOddsPapi }),
    created_at: new Date(at).toISOString(),
  }
  const oddsPapiObservations = eventId === null || freshOddsPapi.length === 0 ? 0 : await db.transaction(async (tx) => {
    const saved = await saveOddsPapiQuotes(tx, eventId, game, freshOddsPapi)
    await tx.insertOrIgnore('prediction_checkpoints', checkpoint)
    return saved
  })
  if (eventId === null || freshOddsPapi.length === 0)
    await db.insertOrIgnore('prediction_checkpoints', checkpoint)
  return { captured: 1, paired: Number(usable && consensus !== null), ...(oddsPapiObservations ? { oddsPapiObservations } : {}) }
}

interface CheckpointRow {
  id: number | string
  event_ticker: string
  ticker: string
  league: string
  start_at: string
  captured_at: string
  settled_at: string
  result: string
  payload: string
}

export async function settlePredictionCheckpoints(db: Database, now = Date.now(), loadMarkets = kalshiMarkets): Promise<number> {
  const rows = await db.query<{ ticker: string }>(`
    SELECT DISTINCT ticker FROM prediction_checkpoints
    WHERE result IS NULL AND start_at BETWEEN ? AND ?
    ORDER BY ticker LIMIT 200
  `).all(new Date(now - 7 * 86_400_000).toISOString(), new Date(now - 150 * 60_000).toISOString())
  if (rows.length === 0)
    return 0
  const markets = await loadMarkets(rows.map(row => row.ticker))
  let settled = 0
  for (const market of markets.values() as Iterable<KalshiMarketInfo>) {
    if (!['settled', 'finalized'].includes(market.status) || !market.result)
      continue
    const settledAt = utcTime(market.settledAt ?? '')
    const result = market.result === 'yes' || market.result === 'no' ? market.result : 'void'
    const changed = await db.query(`
      UPDATE prediction_checkpoints SET result = ?, settled_at = ? WHERE ticker = ? AND result IS NULL
    `).run(result, new Date(Number.isFinite(settledAt) ? settledAt : now).toISOString(), market.ticker)
    settled += changed.changes
  }
  return settled
}

export async function auditRecordedCheckpoints(db: Database, now = Date.now()) {
  const rows = await db.query<CheckpointRow>(`
    SELECT id, event_ticker, ticker, league, start_at, captured_at, settled_at, result, payload
    FROM prediction_checkpoints
    WHERE start_at >= ?
    ORDER BY captured_at DESC, id DESC LIMIT 8000
  `).all(new Date(now - 90 * 86_400_000).toISOString())
  const latest = new Map<string, CheckpointRow>()
  for (const row of rows) {
    if (!latest.has(row.event_ticker))
      latest.set(row.event_ticker, row)
  }
  const settled: AuditGame[] = []
  const sportsbookSettled: Array<Omit<AuditGame, 'bid' | 'ask' | 'consensus'> & { consensus: number }> = []
  const upcoming: Array<Omit<AuditGame, 'settledAt' | 'outcome'>> = []
  let usableKalshiQuotes = 0
  let quotedBySportsbooks = 0
  let capturedWithConsensus = 0
  let oddsPapiGames = 0
  for (const row of latest.values()) {
    const payload = JSON.parse(row.payload) as { bid: number | null, ask: number | null, usable?: boolean, consensus: number | null, context: WinnerContext | null, observations: unknown[], oddsPapiQuotes?: OddsPapiQuote[] }
    if (payload.observations.length > 0) quotedBySportsbooks++
    if (payload.oddsPapiQuotes?.length) oddsPapiGames++
    const winner = {
      ticker: row.ticker, league: row.league, day: sqlDay(row.start_at), at: utcTime(row.captured_at),
      context: payload.context,
    }
    const final = row.result === 'yes' || row.result === 'no'
      ? { settledAt: utcTime(row.settled_at), outcome: (row.result === 'yes' ? 1 : 0) as 0 | 1 }
      : null
    if (final && payload.consensus !== null)
      sportsbookSettled.push({ ...winner, ...final, consensus: payload.consensus })
    if (payload.usable === false || payload.bid === null || payload.ask === null) continue
    usableKalshiQuotes++
    const sample = { ...winner, bid: payload.bid, ask: payload.ask, consensus: payload.consensus }
    if (payload.consensus !== null) capturedWithConsensus++
    if (final)
      settled.push({ ...sample, ...final })
    else if (utcTime(row.start_at) > now)
      upcoming.push(sample)
  }
  return {
    capturedGames: latest.size,
    usableKalshiQuotes,
    quotedBySportsbooks,
    capturedWithConsensus,
    oddsPapiGames,
    pairedSettled: settled.filter(row => row.consensus !== null).length,
    sportsbookOnlyContext: prospectiveSportsbookAudit(sportsbookSettled, outcomeWinnerContext, MIN_PAIRED_CHECKPOINTS),
    prospectiveContext: prospectiveWinnerAudit(settled, frozenWinnerContext, MIN_PAIRED_CHECKPOINTS),
    upcoming: rankCapturedWinners(upcoming, settled, now),
    ...predictionAudit(settled),
  }
}

function sqlDay(value: string) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York' }).format(new Date(utcTime(value)))
}
