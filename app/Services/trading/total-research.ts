import type { Database } from '../../Support/db'
import type { TotalCheckpoint } from './total-checkpoints'
import { utcTime } from './winner-context'

const minute = 60_000
const day = 1440 * minute
const finalScoreLeagues = new Set(['NBA', 'WNBA', 'NFL', 'NCAA Football', 'NCAA Basketball', 'NCAA Women’s Basketball', "NCAA Women's Basketball", 'NHL', 'MLB'])
type Source = 'sportsbook' | 'kalshi' | 'otherExchange'

interface EventRow {
  id: number
  league: string
  commence_at: string
  settled_at: string
  home_score: number
  away_score: number
}

interface ArchivedPrice {
  book: string
  kind: string
  market_id: number
  line: number | string
  point: number | string | null
  side: string
  price: number | string
  capture: number | string
}

interface SeenTotal {
  source: Source
  book: string
  line: number
  over: number
  at: number
}

interface Forecast {
  league: string
  at: number
  settled: number
  over: number
  actual: number
}

function insideWindow(start: number, observed: number): boolean {
  return start - observed >= 30 * minute && start - observed <= 40 * minute
}

function fairOver(over: number, under: number): number | null {
  if (!(over > 1 && under > 1) || !Number.isFinite(over) || !Number.isFinite(under))
    return null
  const hold = 1 / over + 1 / under
  return hold >= .98 && hold <= 1.15 ? 1 / over / hold : null
}

export function archivedTotalPairs(rows: ArchivedPrice[], starts: number): SeenTotal[] {
  const pairs = new Map<string, ArchivedPrice[]>()
  for (const row of rows) {
    const at = typeof row.capture === 'number' ? row.capture : utcTime(row.capture)
    if (row.point == null || Number(row.point) !== Number(row.line) || !insideWindow(starts, at))
      continue
    const key = `${row.book}:${row.market_id}:${at}`
    const group = pairs.get(key) ?? []
    group.push({ ...row, capture: at })
    pairs.set(key, group)
  }
  return [...pairs.values()].flatMap((pair): SeenTotal[] => {
    const above = pair.find(quote => quote.side === 'over')
    const below = pair.find(quote => quote.side === 'under')
    if (pair.length !== 2 || !above || !below)
      return []
    const over = fairOver(Number(above.price), Number(below.price))
    if (over === null)
      return []
    return [{ source: above.kind === 'sportsbook' ? 'sportsbook' : above.book === 'kalshi' ? 'kalshi' : 'otherExchange',
      book: above.book, line: Number(above.line), over, at: Number(above.capture) }]
  })
}

function currentTotalPairs(checkpoint: TotalCheckpoint, starts: number): SeenTotal[] {
  const book = checkpoint.sportsbook.flatMap((pair): SeenTotal[] => {
    const over = fairOver(pair.over.price, pair.under.price)
    return over === null || !insideWindow(starts, pair.checkedAt) ? []
      : [{ source: 'sportsbook', book: pair.bookmaker, line: pair.line, over, at: pair.checkedAt }]
  })
  const exchange = checkpoint.kalshi.flatMap((quote): SeenTotal[] => {
    if (!insideWindow(starts, quote.checkedAt) || quote.askOver - quote.bidOver > .1 || quote.askUnder - quote.bidUnder > .1)
      return []
    const overMid = (quote.bidOver + quote.askOver) / 2
    const underMid = (quote.bidUnder + quote.askUnder) / 2
    return [{ source: 'kalshi', book: 'kalshi', line: quote.line, over: overMid / (overMid + underMid), at: quote.checkedAt }]
  })
  return [...book, ...exchange]
}

/** Use one line per event and source. Repeated ladder strikes cannot inflate the sample. */
function selectTotal(rows: SeenTotal[], source: Source, minimumBooks: number) {
  const lines = new Map<number, Map<string, SeenTotal>>()
  for (const row of rows) {
    if (row.source !== source || !Number.isFinite(row.line) || row.line % .5 !== 0)
      continue
    const books = lines.get(row.line) ?? new Map<string, SeenTotal>()
    if (row.at >= (books.get(row.book)?.at ?? 0))
      books.set(row.book, row)
    lines.set(row.line, books)
  }
  return [...lines.entries()].filter(([, rows]) => rows.size >= minimumBooks)
    .map(([line, byBook]) => {
      const books = [...byBook.values()]
      return { line, books: books.length, over: books.reduce((sum, quote) => sum + quote.over, 0) / books.length,
        at: Math.max(...books.map(quote => quote.at)) }
    })
    .sort((a, b) => b.books - a.books || Math.abs(a.over - .5) - Math.abs(b.over - .5) || b.at - a.at || a.line - b.line)[0]
}

function summarize(forecasts: Forecast[]) {
  const hit = (p: number, actual: number) => p !== .5 && (p > .5 ? 1 : 0) === actual
  const metrics = (rows: Array<{ p: number, actual: number }>) => ({
    games: rows.length,
    picks: rows.filter(row => row.p !== .5).length,
    hits: rows.filter(row => hit(row.p, row.actual)).length,
    brier: rows.length ? rows.reduce((sum, row) => sum + (row.p - row.actual) ** 2, 0) / rows.length : null,
  })
  const market = forecasts.map(row => ({ p: row.over, actual: row.actual }))
  const holdout: typeof market = []
  const adjusted: typeof market = []
  for (const row of forecasts) {
    const prior = forecasts.filter(example => example.league === row.league && example.settled > 0 && example.settled < row.at)
    if (prior.length < 10)
      continue
    const bias = prior.reduce((sum, example) => sum + example.actual - example.over, 0) / (prior.length + 20)
    const probability = Math.max(.01, Math.min(.99, row.over + Math.max(-.08, Math.min(.08, bias))))
    holdout.push({ p: row.over, actual: row.actual })
    adjusted.push({ p: probability, actual: row.actual })
  }
  return {
    market: metrics(market),
    overWins: forecasts.filter(row => row.actual === 1).length,
    pairedCalibration: { baseline: metrics(holdout), adjusted: metrics(adjusted), minimumToEvaluate: 50 },
  }
}

function matchedTotal(rows: SeenTotal[]) {
  const common = new Set(rows.filter(row => row.source === 'kalshi').map(row => row.line))
  const sportsbook = selectTotal(rows.filter(row => common.has(row.line) && row.line % 1 === .5), 'sportsbook', 1)
  if (!sportsbook)
    return null
  const kalshi = selectTotal(rows.filter(row => row.line === sportsbook.line), 'kalshi', 1)
  return kalshi && { line: sportsbook.line, at: Math.max(sportsbook.at, kalshi.at), sportsbook: sportsbook.over, kalshi: kalshi.over }
}

export async function totalsReport(db: Database, days = 30, now = Date.now()) {
  const since = new Date(now - days * day).toISOString()
  const events = await db.query<EventRow>(`
    SELECT e.id, e.league, e.commence_at, r.settled_at, r.home_score, r.away_score
    FROM market_events e JOIN event_results r ON r.market_event_id = e.id
    WHERE r.completed = 1 AND r.home_score IS NOT NULL AND r.away_score IS NOT NULL AND e.commence_at >= ?
    ORDER BY e.commence_at ASC
  `).all(since)
  const checks = await db.query<{ payload: string }>(`
    SELECT payload FROM prediction_checkpoints WHERE captured_at >= ? AND payload LIKE '%"totals":%'
  `).all(since)
  const current = new Map<number, TotalCheckpoint[]>()
  for (const row of checks) {
    const totals = (JSON.parse(row.payload) as { totals?: TotalCheckpoint & { eventId: number | null } }).totals
    if (!totals?.eventId)
      continue
    const id = Number(totals.eventId)
    const list = current.get(id) ?? []
    list.push(totals)
    current.set(id, list)
  }

  const groups = [
    { key: 'sportsbook', source: 'sportsbook', minimum: 1 },
    { key: 'sportsbookConsensus', source: 'sportsbook', minimum: 2 },
    { key: 'kalshi', source: 'kalshi', minimum: 1 },
    { key: 'otherExchange', source: 'otherExchange', minimum: 1 },
  ] as const
  const forecasts = new Map<string, Forecast[]>()
  const pushes = new Map<string, number>()
  const matched = { sportsbook: [] as Forecast[], kalshi: [] as Forecast[], blend: [] as Forecast[] }
  const eligible = events.filter(row => finalScoreLeagues.has(row.league))
  for (let i = 0; i < eligible.length; i += 8) {
    await Promise.all(eligible.slice(i, i + 8).map(async (event) => {
      const id = Number(event.id)
      const starts = utcTime(event.commence_at)
      if (!Number.isFinite(starts))
        return
      const lower = starts - 40 * minute
      const upper = starts - 30 * minute
      const [changed, observed] = await Promise.all([
        db.query<ArchivedPrice>(`
          SELECT b.slug AS book, b.kind, m.id AS market_id, m.line, q.point, s.side, q.price, q.captured_at AS capture
          FROM markets m JOIN selections s ON s.market_id = m.id
          JOIN odds_snapshots q ON q.selection_id = s.id JOIN bookmakers b ON b.id = q.bookmaker_id
          WHERE m.market_event_id = ? AND m.market_type = 'totals' AND m.period = 'full_game'
            AND s.side IN ('over','under') AND q.captured_at BETWEEN ? AND ?
        `).all(id, new Date(lower).toISOString(), new Date(upper).toISOString()),
        db.query<ArchivedPrice>(`
          SELECT b.slug AS book, b.kind, m.id AS market_id, m.line, q.point, s.side, q.price, q.checked_at_ms AS capture
          FROM markets m JOIN selections s ON s.market_id = m.id
          JOIN sportsbook_quote_observations q ON q.selection_id = s.id JOIN bookmakers b ON b.id = q.bookmaker_id
          WHERE m.market_event_id = ? AND m.market_type = 'totals' AND m.period = 'full_game'
            AND s.side IN ('over','under') AND q.available = 1 AND q.checked_at_ms BETWEEN ? AND ?
        `).all(id, lower, upper),
      ])
      const rows = [...archivedTotalPairs(changed, starts),
        ...archivedTotalPairs(observed.map(row => ({ ...row, capture: Number(row.capture) })), starts),
        ...(current.get(id) ?? []).flatMap(total => currentTotalPairs(total, starts))]
      const score = Number(event.home_score) + Number(event.away_score)
      const settled = utcTime(event.settled_at)
      const common = matchedTotal(rows)
      if (common) {
        const example = { league: event.league, at: common.at, settled, actual: Number(score > common.line) }
        matched.sportsbook.push({ ...example, over: common.sportsbook })
        matched.kalshi.push({ ...example, over: common.kalshi })
        matched.blend.push({ ...example, over: (common.sportsbook + common.kalshi) / 2 })
      }
      for (const { key, source, minimum } of groups) {
        const selected = selectTotal(rows, source, minimum)
        if (!selected)
          continue
        if (score === selected.line) {
          pushes.set(key, (pushes.get(key) ?? 0) + 1)
          continue
        }
        const list = forecasts.get(key) ?? []
        list.push({ league: event.league, at: selected.at, settled, over: selected.over, actual: Number(score > selected.line) })
        forecasts.set(key, list)
      }
    }))
  }

  return {
    days,
    settledEvents: eligible.length,
    eventsWithNewCheckpoints: current.size,
    sameGameAndLine: {
      sportsbook: summarize(matched.sportsbook),
      kalshi: summarize(matched.kalshi),
      equalWeightBlend: summarize(matched.blend),
    },
    sources: Object.fromEntries(groups.map(({ key }) => {
      const rows = forecasts.get(key) ?? []
      const leagues = [...new Set(rows.map(row => row.league))].sort()
      return [key, { pushes: pushes.get(key) ?? 0, ...summarize(rows),
        leagues: Object.fromEntries(leagues.map(league => [league, summarize(rows.filter(row => row.league === league))])) }]
    })),
  }
}
