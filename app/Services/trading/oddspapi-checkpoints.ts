import type { Database } from '../../Support/db'
import type { LiveGame, LiveTeam } from './live-games'
import { loadBookmakerIndex } from '../ingest/prices'
import { resolveMarket, resolveSelection } from '../ingest/resolve'
import { utcTime } from './winner-context'

const dayMs = 86_400_000
const bucketMs = 5 * 60_000
const sportsbooks = ['pinnacle', 'draftkings'] as const
const tournaments: Record<string, { tournament: number, winner: number }> = {
  nba: { tournament: 132, winner: 111 },
  wnba: { tournament: 486, winner: 111 },
  ncaab: { tournament: 648, winner: 111 },
  ncaaw: { tournament: 21384, winner: 111 },
  nfl: { tournament: 31, winner: 141 },
  ncaaf: { tournament: 27653, winner: 141 },
  nhl: { tournament: 234, winner: 151 },
  mlb: { tournament: 109, winner: 131 },
}

interface Offer {
  active?: boolean
  price?: number
  changedAt?: string
  bookmakerChangedAt?: string
}

interface WinnerMarket {
  marketActive?: boolean
  outcomes?: Record<string, { players?: Record<string, Offer> }>
}

interface Fixture {
  fixtureId: string
  tournamentId: number
  startTime: string
  trueStartTime?: string | null
  statusName?: string
  participant1Name?: string
  participant1ShortName?: string
  participant1Abbr?: string
  participant2Name?: string
  participant2ShortName?: string
  participant2Abbr?: string
  bookmakerOdds?: Record<string, { bookmakerIsActive?: boolean, suspended?: boolean, markets?: Record<string, WinnerMarket> }>
}

export interface OddsPapiBoard {
  book: string
  checkedAt: number
  fixtures: Fixture[]
}

export interface OddsPapiQuote {
  bookmaker: string
  side: 'home' | 'away'
  price: number
  observed_at: string
  updated_at: string
  source: 'oddspapi'
  fixtureId: string
}

interface Account {
  current_subscription_id?: string
  subscriptions?: Array<{ subscription_id?: string, is_active?: boolean, request_limit?: number, request_count?: number }>
}

async function request<T>(route: string, apiKey: string, params: Record<string, string> = {}): Promise<T | null> {
  const url = new URL(route, 'https://api.oddspapi.io/v4/')
  url.searchParams.set('apiKey', apiKey)
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  // Never log the URL, since the provider authenticates in the query string.
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    return response.ok ? await response.json() as T : null
  }
  catch {
    return null
  }
}

export function oddsPapiAllowance(now: number, limit: number, used: number, usedToday: number): number {
  const date = new Date(now)
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1)
  const dayStart = Math.floor(now / dayMs) * dayMs
  const days = Math.max(1, (nextMonth - dayStart) / dayMs)
  // The vendor also locks out the free historical endpoint at the quota limit.
  const remaining = Math.max(0, limit - used - 1)
  return Math.max(0, Math.min(remaining, Math.ceil((remaining + usedToday) / days) - usedToday))
}

export async function loadOddsPapiBoards(db: Database, leagues: string[], apiKey = process.env.ODDSPAPI_API_KEY): Promise<OddsPapiBoard[]> {
  const ids = [...new Set(leagues.flatMap(league => tournaments[league]?.tournament ?? []))]
  if (!apiKey || ids.length === 0)
    return []

  const now = Date.now()
  const slot = Math.floor(now / bucketMs) * bucketMs
  const duplicate = await db.query('SELECT bucket_ms FROM sportsbook_capture_budget WHERE bucket_ms = ?').get(slot)
  if (duplicate)
    return []

  const account = await request<Account>('account', apiKey)
  const plan = account?.subscriptions?.find(s => s.subscription_id === account.current_subscription_id)
    ?? account?.subscriptions?.find(s => s.is_active)
  const limit = Number(plan?.request_limit)
  const used = Number(plan?.request_count)
  if (!Number.isInteger(limit) || !Number.isInteger(used) || limit < 2 || used < 0)
    return []

  const today = await db.query<{ used: number | string }>('SELECT COALESCE(SUM(requests), 0) AS used FROM sportsbook_capture_budget WHERE bucket_ms >= ?').get(Math.floor(now / dayMs) * dayMs)
  const available = oddsPapiAllowance(now, limit, used, Number(today?.used ?? 0))
  const groups = Array.from({ length: Math.min(Math.ceil(ids.length / 3), Math.floor(available / sportsbooks.length)) }, (_, i) => ids.slice(i * 3, i * 3 + 3))
  if (groups.length === 0)
    return []

  const claimed = await db.upsert('sportsbook_capture_budget', [{ bucket_ms: slot, requests: groups.length * sportsbooks.length }], ['bucket_ms'])
  if (claimed.changes === 0)
    return []

  const boards: OddsPapiBoard[] = []
  for (const group of groups) {
    for (const book of sportsbooks) {
      if (boards.length > 0)
        await Bun.sleep(1_100)
      const data = await request<Record<string, Fixture> | Fixture[]>('odds-by-tournaments', apiKey, { tournamentIds: group.join(','), bookmaker: book, verbosity: '3' })
      if (data === null)
        return boards
      boards.push({ book, checkedAt: Date.now(), fixtures: Object.values(data) })
    }
  }
  return boards
}

function teamKey(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, '').replace(/\bst\b/g, 'state')
    .replace(/\bapp state\b/g, 'appalachian state').replace(/\biu indianapolis\b/g, 'iu indy').replace(/\bflorida international\b/g, 'fiu')
    .replace(/\bcornhuskers\b/g, 'huskers').replace(/\blady\b/g, '').replace(/\s/g, '')
}

function matchesTeam(team: LiveTeam, names: Array<string | undefined>): boolean {
  const keys = [team.name, team.location, team.abbreviation].filter(Boolean).map(teamKey)
  return names.some(name => name && keys.includes(teamKey(name)))
}

export function matchOddsPapiQuotes(game: LiveGame, boards: OddsPapiBoard[], cutoff?: number): OddsPapiQuote[] {
  const league = tournaments[game.league]
  if (!league || game.state !== 'pre')
    return []
  const startsAt = utcTime(game.startsAt)
  return boards.flatMap(({ book, checkedAt, fixtures }) => {
    if (cutoff !== undefined && checkedAt > cutoff)
      return []
    const fixturesForGame = fixtures.flatMap(fixture => {
      const providerStart = utcTime(fixture.startTime)
      if (fixture.tournamentId !== league.tournament || !fixture.fixtureId || !Number.isFinite(providerStart)
        || !['Pre-Game', 'Scheduled'].includes(fixture.statusName ?? '') || fixture.trueStartTime
        || Math.abs(providerStart - startsAt) > 60 * 60_000 || checkedAt >= providerStart
        || (cutoff !== undefined && checkedAt > providerStart - 30 * 60_000))
        return []
      const p1 = [fixture.participant1Name, fixture.participant1ShortName, fixture.participant1Abbr]
      const p2 = [fixture.participant2Name, fixture.participant2ShortName, fixture.participant2Abbr]
      const homeFirst = matchesTeam(game.home, p1) && matchesTeam(game.away, p2)
      const awayFirst = matchesTeam(game.away, p1) && matchesTeam(game.home, p2)
      return homeFirst !== awayFirst ? [{ fixture, homeFirst }] : []
    })
    if (fixturesForGame.length !== 1)
      return []
    const { fixture, homeFirst } = fixturesForGame[0]!
    const offerBoard = fixture.bookmakerOdds?.[book]
    const market = offerBoard?.markets?.[league.winner]
    if (!offerBoard?.bookmakerIsActive || offerBoard.suspended || !market?.marketActive)
      return []
    return [0, 1].flatMap((index): OddsPapiQuote[] => {
      const offer = market.outcomes?.[league.winner + index]?.players?.['0']
      const price = offer?.price
      if (!offer?.active || typeof price !== 'number' || !Number.isFinite(price) || price <= 1)
        return []
      const observed = offer.bookmakerChangedAt || offer.changedAt || ''
      if (observed && (!Number.isFinite(utcTime(observed)) || utcTime(observed) > checkedAt))
        return []
      return [{
        bookmaker: book,
        side: homeFirst === (index === 0) ? 'home' : 'away',
        price,
        observed_at: observed,
        updated_at: new Date(checkedAt).toISOString(),
        source: 'oddspapi',
        fixtureId: fixture.fixtureId,
      }]
    })
  })
}

/** Save independently observed prices for history without changing current trading prices. */
export async function saveOddsPapiQuotes(db: Database, eventId: number, game: LiveGame, quotes: OddsPapiQuote[]): Promise<number> {
  if (quotes.length === 0)
    return 0
  const bookmakerIndex = await loadBookmakerIndex(db)
  const marketId = await resolveMarket(db, { eventId, marketType: 'h2h', line: null, period: 'full_game', label: 'Moneyline', complete: true })
  const selectionIds = new Map<string, number>()
  const rows: Record<string, unknown>[] = []
  for (const quote of quotes) {
    const bookmaker = bookmakerIndex.get(quote.bookmaker)
    if (!bookmaker || bookmaker.kind !== 'sportsbook')
      continue
    let selectionId = selectionIds.get(quote.side)
    if (selectionId === undefined) {
      selectionId = await resolveSelection(db, { marketId, label: game[quote.side].name, side: quote.side, point: null, position: quote.side === 'home' ? 0 : 1 })
      selectionIds.set(quote.side, selectionId)
    }
    rows.push({ selection_id: selectionId, bookmaker_id: bookmaker.id, checked_at_ms: utcTime(quote.updated_at), observed_at: quote.observed_at || null, price: quote.price, point: null, available: 1, source: quote.source })
  }
  return (await db.upsert('sportsbook_quote_observations', rows, ['selection_id', 'bookmaker_id', 'checked_at_ms'])).changes
}
