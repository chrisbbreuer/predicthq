/**
 * Odds math and comparison-board assembly.
 *
 * Turns the rows written by ingestion into the view-model the API and the
 * pages render: best price per outcome, the de-vigged fair probability
 * behind it, and the per-market hold or arbitrage.
 *
 * ### What changed
 * `loadBoard()` used to read every row in the database on every request
 * and then run one more query *per selection* to fetch its sparkline — an
 * N+1 that was invisible at twelve seeded events and fatal at a real
 * schedule. It now takes filters and a limit, and fetches history for the
 * whole page in a single windowed query.
 *
 * It also reports honest numbers. The old `edgeVsAvgPct` compared the best
 * price to the *average price*, which measures how much one book disagrees
 * with the others — not whether the bet is good. Real edge is the best
 * price against the de-vigged fair probability, and that now comes from
 * `fair_prices`. The old field is kept, because the pages render it, but
 * it sits beside the meaningful one rather than standing in for it.
 */

import type { Binding } from '../Services/ingest/resolve'
import { Database } from './db'
import { recentMoves } from '../Services/quant/movement'
import { impliedProbability, toAmericanNumber } from './keys'

export type BookmakerKind = 'sportsbook' | 'prediction'

export interface Bookmaker {
  id: number
  name: string
  slug: string
  kind: BookmakerKind
  accent: string
  short: string
  sharp: boolean
}

export { impliedProbability }

/** Decimal odds to American (moneyline) text, e.g. +138 / -145. */
export function toAmerican(decimal: number): string {
  const n = toAmericanNumber(decimal)
  return n >= 0 ? `+${n}` : String(n)
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    [a, b] = [b, a % b]
  }
  return a
}

/**
 * Decimal odds to traditional fractional odds (2.50 becomes "3/2").
 *
 * Approximates the profit ratio with the closest fraction whose
 * denominator is 20 or less, then reduces it — close enough to the
 * fractions books actually quote without a lookup ladder.
 */
export function toFractional(decimal: number): string {
  const profit = decimal - 1
  if (profit <= 0)
    return '0/1'

  let bestP = Math.round(profit)
  let bestQ = 1
  let bestErr = Math.abs(profit - bestP)

  for (let q = 1; q <= 20; q++) {
    const p = Math.round(profit * q)
    const err = Math.abs(profit - p / q)
    if (err < bestErr - 1e-9) {
      bestP = p
      bestQ = q
      bestErr = err
    }
  }

  const g = gcd(bestP, bestQ) || 1
  return `${bestP / g}/${bestQ / g}`
}

export interface MarketHold {
  bestBookSum: number
  /** Positive means an unavoidable margin; the lower, the better for bettors. */
  holdPct: number
  /** True when the best prices across books guarantee a profit. */
  isArbitrage: boolean
  /** Guaranteed return when an arbitrage exists, else 0. */
  arbitragePct: number
}

export interface QuoteCell {
  bookmakerId: number
  price: number | null
  american: string | null
  fractional: string | null
  point: number | null
  isBest: boolean
}

export interface SelectionView {
  id: number
  label: string
  side: string
  point: number | null
  bestBookmakerId: number | null
  bestPrice: number | null
  bestAmerican: string | null
  bestFractional: string | null
  bestImpliedPct: number
  average: number
  /**
   * How far the best price beats the field average, as a percent.
   *
   * A measure of book disagreement, not of value — kept because the pages
   * render it. `edgePct` is the number that answers "is this a good bet".
   */
  edgeVsAvgPct: number
  /** De-vigged fair probability, 0..1. Null until the quant pass has run. */
  fairProb: number | null
  /** Fair probability from sharp books alone. */
  sharpProb: number | null
  /** Expected return at the best price against fair value, as a percent. */
  edgePct: number | null
  /** Fractional Kelly stake at that edge. */
  kellyFraction: number | null
  bookCount: number
  /** Recent prices, oldest to newest, for the best book's sparkline. */
  bestHistory: number[]
  quotes: QuoteCell[]
}

export interface MarketView {
  id: number
  marketType: string
  label: string
  line: number | null
  period: string
  complete: boolean
  selections: SelectionView[]
  hold: MarketHold | null
}

export interface EventView {
  id: number
  title: string
  category: string
  league: string
  sport: string
  /** UTC ISO-8601 kickoff. Formatting is the render layer's job. */
  commenceAt: string
  status: string
  statusDetail: string
  venue: string
  home: string | null
  away: string | null
  /** Minutes since any price on this event last moved. */
  updatedMinutesAgo: number
  bookmakerIds: number[]
  markets: MarketView[]
  /** The moneyline market's hold, hoisted for the event-level display. */
  hold: MarketHold | null

  // ---- projection of the primary market ------------------------------------
  // An event now owns many markets, but the pages were written when it
  // owned one flat list of selections. These project the primary market —
  // the moneyline where there is one — back onto the event so those pages
  // keep rendering. `markets` is the real structure; prefer it in new code.

  /** The primary market's selections. */
  selections: SelectionView[]
  /** The primary market's label, e.g. "Moneyline". */
  market: string
  /** `commenceAt` rendered for display. Formatting belongs to the client. */
  startsAt: string
}

export interface OddsSummary {
  eventCount: number
  bookmakerCount: number
  sportsbookCount: number
  predictionCount: number
  marketCount: number
  selectionCount: number
  arbitrageCount: number
  /** Mean best-vs-field spread across every selection, as a percent. */
  avgEdgePct: number
  /** Mean honest edge against fair value, as a percent. */
  avgTrueEdgePct: number
}

export interface Board {
  bookmakers: Bookmaker[]
  events: EventView[]
  summary: OddsSummary
  categories: string[]
  /** Total matching the filter, before the limit — for pagination. */
  total: number
}

export interface BoardOptions {
  sport?: string
  category?: string
  status?: string
  marketType?: string
  /** Only events starting at or after this ISO instant. */
  from?: string
  /** Only events starting at or before this ISO instant. */
  to?: string
  limit?: number
  offset?: number
  /** Points of history per selection. 0 skips the query entirely. */
  historyPoints?: number
}

/**
 * Line-shopping hold across books.
 *
 * Combines the best available price for every selection in one market.
 * When the implied probabilities sum below 1 there is a cross-book
 * arbitrage — a guaranteed profit from splitting the stake.
 *
 * Only meaningful on a complete market, where the outcomes partition the
 * space. Summing across an incomplete one produces a number that looks
 * like a hold and means nothing.
 */
export function marketHold(selections: Array<{ bestPrice: number | null }>): MarketHold {
  let sum = 0
  for (const selection of selections) {
    if (selection.bestPrice && selection.bestPrice > 1)
      sum += impliedProbability(selection.bestPrice)
  }
  return {
    bestBookSum: sum,
    holdPct: (sum - 1) * 100,
    isArbitrage: sum > 0 && sum < 1,
    arbitragePct: sum > 0 && sum < 1 ? (1 - sum) * 100 : 0,
  }
}

interface QuoteRow {
  selection_id: number
  bookmaker_id: number
  price: number
  point: number | null
  updated_at: string
}

/**
 * Load the comparison board.
 *
 * Five queries regardless of how many events match: books, the event page,
 * markets, selections with their fair prices, and every quote. History is
 * one more, and only when asked for. Nothing runs per row.
 */
export async function loadBoard(options: BoardOptions = {}): Promise<Board> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const offset = Math.max(0, options.offset ?? 0)
  const historyPoints = options.historyPoints ?? 30

  const db = new Database()
  try {
    const bookmakers = (await db
      .query<{ id: number, name: string, slug: string, kind: string, accent: string, short: string, sharp: number }>('SELECT id, name, slug, kind, accent, short, sharp FROM bookmakers WHERE active = 1 ORDER BY id ASC')
      .all())
      .map(b => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        kind: (b.kind === 'prediction' ? 'prediction' : 'sportsbook') as BookmakerKind,
        accent: b.accent,
        short: b.short,
        sharp: b.sharp === 1,
      }))

    const where: string[] = ['1 = 1']
    const params: Binding[] = []

    // Default to events that can still be bet on.
    //
    // Without this the board is ordered by kickoff ascending and the first
    // page is whatever finished earliest — games with no live prices at
    // all, so the comparison tables render empty while the event count
    // says there is plenty to show. An explicit `status`, `from`, or `to`
    // turns the default off, so asking for finished games still works.
    if (!options.status && !options.from && !options.to)
      where.push(`e.status IN ('scheduled', 'live')`)

    if (options.sport) {
      where.push('sp.slug = ?')
      params.push(options.sport)
    }
    if (options.category) {
      where.push('e.category = ?')
      params.push(options.category)
    }
    if (options.status) {
      where.push('e.status = ?')
      params.push(options.status)
    }
    if (options.from) {
      where.push('e.commence_at >= ?')
      params.push(options.from)
    }
    if (options.to) {
      where.push('e.commence_at <= ?')
      params.push(options.to)
    }

    const clause = where.join(' AND ')

    const total = (await db.query<{ n: number }>(`
      SELECT COUNT(*) AS n FROM market_events e
      JOIN sports sp ON sp.id = e.sport_id
      WHERE ${clause}
    `).get(...params))?.n ?? 0

    const eventRows = await db.query<Record<string, any>>(`
      SELECT e.id, e.title, e.category, e.league, e.commence_at, e.status, e.status_detail,
            e.venue, sp.slug AS sport,
            home.name AS home_name, away.name AS away_name
      FROM market_events e
      JOIN sports sp ON sp.id = e.sport_id
      LEFT JOIN sports_teams home ON home.id = e.home_sports_team_id
      LEFT JOIN sports_teams away ON away.id = e.away_sports_team_id
      WHERE ${clause}
      ORDER BY e.commence_at ASC, e.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset)

    if (eventRows.length === 0) {
      return {
        bookmakers,
        events: [],
        summary: emptySummary(bookmakers),
        categories: await loadCategories(db),
        total,
      }
    }

    const eventIds = eventRows.map(r => r.id as number)
    const idList = eventIds.join(',')
    const typeFilter = options.marketType ? `AND m.market_type = '${options.marketType.replace(/[^a-z0-9_]/gi, '')}'` : ''

    const marketRows = await db.query<Record<string, any>>(`
      SELECT id, market_event_id, market_type, label, line, period, complete
      FROM markets m
      WHERE m.market_event_id IN (${idList}) ${typeFilter}
      ORDER BY m.position ASC, m.id ASC
    `).all()

    const selectionRows = await db.query<Record<string, any>>(`
      SELECT s.id, s.market_id, s.label, s.side, s.point, s.position,
            f.prob_consensus, f.prob_sharp, f.edge_pct, f.kelly_fraction, f.book_count
      FROM selections s
      JOIN markets m ON m.id = s.market_id
      LEFT JOIN fair_prices f ON f.selection_id = s.id
      WHERE m.market_event_id IN (${idList}) ${typeFilter}
      ORDER BY s.position ASC, s.id ASC
    `).all()

    const quoteRows = await db.query<QuoteRow>(`
      SELECT o.selection_id, o.bookmaker_id, o.price, o.point, o.updated_at
      FROM odds o
      JOIN selections s ON s.id = o.selection_id
      JOIN markets m ON m.id = s.market_id
      WHERE m.market_event_id IN (${idList}) AND o.available = 1 ${typeFilter}
    `).all()

    // Vitess returns DECIMAL columns as strings. Left that way, prices
    // compared as text ("10.00" < "2.10") and summed by concatenation, so
    // the board could crown the wrong best price; the page's own
    // `.toFixed` then threw and emptied every price cell.
    const quotesBySelection = new Map<number, QuoteRow[]>()
    for (const raw of quoteRows) {
      const row: QuoteRow = {
        ...raw,
        selection_id: Number(raw.selection_id),
        bookmaker_id: Number(raw.bookmaker_id),
        price: Number(raw.price),
        point: raw.point === null || raw.point === undefined ? raw.point : Number(raw.point),
      }
      const list = quotesBySelection.get(row.selection_id) ?? []
      list.push(row)
      quotesBySelection.set(row.selection_id, list)
    }

    // History for every selection on the page in one windowed query,
    // replacing the per-selection query that made this endpoint O(n).
    const historyBySelection = new Map<number, number[]>()
    if (historyPoints > 0) {
      const historyRows = await db.query<{ selection_id: number, price: number }>(`
        WITH ranked AS (
          SELECT os.selection_id, os.price, os.captured_at,
                ROW_NUMBER() OVER (
                  PARTITION BY os.selection_id ORDER BY os.captured_at DESC, os.id DESC
                ) AS rn
          FROM odds_snapshots os
          JOIN selections s ON s.id = os.selection_id
          JOIN markets m ON m.id = s.market_id
          WHERE m.market_event_id IN (${idList}) ${typeFilter}
        )
        SELECT selection_id, price FROM ranked WHERE rn <= ?
        ORDER BY selection_id ASC, captured_at ASC
      `).all(historyPoints)

      for (const row of historyRows) {
        const id = Number(row.selection_id)
        const list = historyBySelection.get(id) ?? []
        list.push(Number(row.price))
        historyBySelection.set(id, list)
      }
    }

    const selectionsByMarket = new Map<number, SelectionView[]>()
    for (const row of selectionRows) {
      const quotes = quotesBySelection.get(Number(row.id)) ?? []

      let best: { bookmakerId: number, price: number } | null = null
      let sum = 0
      for (const q of quotes) {
        sum += q.price
        if (best === null || q.price > best.price)
          best = { bookmakerId: q.bookmaker_id, price: q.price }
      }
      const average = quotes.length > 0 ? sum / quotes.length : 0

      const view: SelectionView = {
        id: Number(row.id),
        label: row.label,
        side: row.side,
        point: row.point === null || row.point === undefined ? null : Number(row.point),
        bestBookmakerId: best?.bookmakerId ?? null,
        bestPrice: best?.price ?? null,
        bestAmerican: best ? toAmerican(best.price) : null,
        bestFractional: best ? toFractional(best.price) : null,
        bestImpliedPct: best ? impliedProbability(best.price) * 100 : 0,
        average,
        edgeVsAvgPct: best && average ? (best.price / average - 1) * 100 : 0,
        fairProb: row.prob_consensus === null || row.prob_consensus === undefined ? null : Number(row.prob_consensus),
        sharpProb: row.prob_sharp === null || row.prob_sharp === undefined ? null : Number(row.prob_sharp),
        edgePct: row.edge_pct === null || row.edge_pct === undefined ? null : Number(row.edge_pct),
        kellyFraction: row.kelly_fraction === null || row.kelly_fraction === undefined ? null : Number(row.kelly_fraction),
        bookCount: row.book_count === null || row.book_count === undefined ? quotes.length : Number(row.book_count),
        bestHistory: historyBySelection.get(Number(row.id)) ?? [],
        quotes: [],
      }

      const byBook = new Map(quotes.map(q => [q.bookmaker_id, q]))
      view.quotes = bookmakers
        .filter(b => byBook.has(b.id))
        .map((b) => {
          const q = byBook.get(b.id)!
          return {
            bookmakerId: b.id,
            price: q.price,
            american: toAmerican(q.price),
            fractional: toFractional(q.price),
            point: q.point,
            isBest: best !== null && b.id === best.bookmakerId,
          }
        })

      const list = selectionsByMarket.get(row.market_id) ?? []
      list.push(view)
      selectionsByMarket.set(row.market_id, list)
    }

    const marketsByEvent = new Map<number, MarketView[]>()
    for (const row of marketRows) {
      const selections = selectionsByMarket.get(row.id) ?? []
      const view: MarketView = {
        id: row.id,
        marketType: row.market_type,
        label: row.label,
        line: row.line,
        period: row.period,
        complete: Boolean(row.complete),
        selections,
        hold: row.complete && selections.length >= 2 ? marketHold(selections) : null,
      }
      const list = marketsByEvent.get(row.market_event_id) ?? []
      list.push(view)
      marketsByEvent.set(row.market_event_id, list)
    }

    // Freshness per event, from the newest quote on it — derived rather
    // than stored, so it cannot go stale the moment it is written.
    //
    // Indexed rather than searched: resolving each quote's event with a
    // linear `find` over the selection and market arrays is quadratic, and
    // at a few thousand quotes on a page that alone costs more than every
    // database query combined.
    const eventBySelection = new Map<number, number>()
    const eventByMarket = new Map<number, number>(
      marketRows.map(m => [m.id as number, m.market_event_id as number]),
    )
    for (const row of selectionRows) {
      const eventId = eventByMarket.get(row.market_id)
      if (eventId !== undefined)
        eventBySelection.set(row.id, eventId)
    }

    const freshness = new Map<number, string>()
    for (const row of quoteRows) {
      const eventId = eventBySelection.get(row.selection_id)
      if (eventId === undefined)
        continue
      const current = freshness.get(eventId)
      if (!current || row.updated_at > current)
        freshness.set(eventId, row.updated_at)
    }

    const now = Date.now()
    const events: EventView[] = eventRows.map((row) => {
      const markets = marketsByEvent.get(row.id) ?? []
      const bookmakerIds = bookmakers
        .map(b => b.id)
        .filter(id => markets.some(m => m.selections.some(s => s.quotes.some(q => q.bookmakerId === id))))

      const updatedAt = freshness.get(row.id)
      const updatedMinutesAgo = updatedAt
        ? Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
        : 0

      const primary = markets.find(m => m.marketType === 'h2h') ?? markets[0] ?? null

      return {
        id: row.id,
        title: row.title,
        category: row.category,
        league: row.league,
        sport: row.sport,
        commenceAt: row.commence_at,
        status: row.status,
        statusDetail: row.status_detail ?? '',
        venue: row.venue ?? '',
        home: row.home_name ?? null,
        away: row.away_name ?? null,
        updatedMinutesAgo,
        bookmakerIds,
        markets,
        hold: primary?.hold ?? null,
        selections: primary?.selections ?? [],
        market: primary?.label || primary?.marketType || '',
        startsAt: formatStart(row.commence_at, row.status),
      }
    })

    let edgeSum = 0
    let edgeCount = 0
    let trueEdgeSum = 0
    let trueEdgeCount = 0
    let marketCount = 0
    let selectionCount = 0
    let arbitrageCount = 0

    for (const event of events) {
      for (const market of event.markets) {
        marketCount++
        if (market.hold?.isArbitrage)
          arbitrageCount++
        for (const selection of market.selections) {
          selectionCount++
          edgeSum += selection.edgeVsAvgPct
          edgeCount++
          if (selection.edgePct !== null) {
            trueEdgeSum += selection.edgePct
            trueEdgeCount++
          }
        }
      }
    }

    return {
      bookmakers,
      events,
      summary: {
        eventCount: events.length,
        bookmakerCount: bookmakers.length,
        sportsbookCount: bookmakers.filter(b => b.kind === 'sportsbook').length,
        predictionCount: bookmakers.filter(b => b.kind === 'prediction').length,
        marketCount,
        selectionCount,
        arbitrageCount,
        avgEdgePct: edgeCount ? edgeSum / edgeCount : 0,
        avgTrueEdgePct: trueEdgeCount ? trueEdgeSum / trueEdgeCount : 0,
      },
      categories: await loadCategories(db),
      total,
    }
  }
  finally {
    db.close()
  }
}

/**
 * A short human rendering of a kickoff time.
 *
 * The stored value is a real UTC timestamp; this is only for the pages
 * that previously received a pre-formatted string. Anything new should
 * take `commenceAt` and format it client-side, where the viewer's timezone
 * is actually known — this necessarily guesses at it.
 */
function formatStart(commenceAt: string, status: string): string {
  const ms = Date.parse(commenceAt)
  if (!Number.isFinite(ms))
    return ''

  if (status === 'final')
    return 'Final'
  if (status === 'live')
    return 'Live'
  if (status === 'postponed' || status === 'cancelled')
    return status.charAt(0).toUpperCase() + status.slice(1)

  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })

  const days = Math.floor((ms - Date.now()) / 86_400_000)
  if (days <= 0)
    return `Today · ${time}`
  if (days === 1)
    return `Tomorrow · ${time}`

  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })} · ${time}`
}

async function loadCategories(db: Database): Promise<string[]> {
  return (await db
    .query(`SELECT DISTINCT category FROM market_events WHERE category != '' ORDER BY category`)
    .all() as Array<{ category: string }>)
    .map(r => r.category)
}

function emptySummary(bookmakers: Bookmaker[]): OddsSummary {
  return {
    eventCount: 0,
    bookmakerCount: bookmakers.length,
    sportsbookCount: bookmakers.filter(b => b.kind === 'sportsbook').length,
    predictionCount: bookmakers.filter(b => b.kind === 'prediction').length,
    marketCount: 0,
    selectionCount: 0,
    arbitrageCount: 0,
    avgEdgePct: 0,
    avgTrueEdgePct: 0,
  }
}

export interface LineMove {
  selectionId: number
  marketEventId: number
  pick: string
  game: string
  league: string
  category: string
  book: string
  bookSlug: string
  marketType: string
  from: number
  to: number
  dir: 'up' | 'down'
  movePct: number
  at: string
}

/**
 * The most recent price moves across all books, newest first.
 *
 * Delegates to the windowed query in `Services/quant/movement.ts`, which
 * finds each quote's last two observations in the database. The previous
 * implementation pulled a fixed 6,000 rows and paired them in JavaScript,
 * so it both did far more work than needed and silently missed moves once
 * the tape grew past that slab.
 */
export async function loadRecentMoves(limit = 40): Promise<LineMove[]> {
  const db = new Database()
  try {
    return (await recentMoves(db, limit)).map(m => ({
      selectionId: m.selectionId,
      marketEventId: m.marketEventId,
      pick: m.pick,
      game: m.title,
      league: m.league,
      category: m.league,
      book: m.book,
      bookSlug: m.bookSlug,
      marketType: m.marketType,
      from: m.from,
      to: m.to,
      dir: m.dir,
      movePct: m.movePct,
      at: m.at,
    }))
  }
  finally {
    db.close()
  }
}
