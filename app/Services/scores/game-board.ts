import type { Database } from '../../Support/db'

/**
 * A game's prices from our own odds feed, laid out the way a sportsbook
 * card is: spread, winner and total for each side.
 *
 * The feed holds every book's latest price per selection. For a card that
 * reads in one glance this picks, per bet type, one line and one book:
 *
 * - **Winner** from the first exchange quoting it, in the order below.
 * - **Spread and total** at the main line, which is the line whose two
 *   sides are priced closest to even. Exchanges list a ladder of
 *   alternates, and the 11.5 a market barely trades says less than the
 *   14.5 it does.
 *
 * Prices are decimal odds, so `1.83` means a dollar returns $1.83.
 */

/** Books preferred for the card, best first. */
const PREFERENCE = ['kalshi', 'polymarket', 'pinnacle', 'draftkings']

export interface BoardPrice {
  price: number
  book: string
  point: number | null
}

export interface GameBoard {
  winner: { away: BoardPrice | null, home: BoardPrice | null, draw: BoardPrice | null }
  spread: { away: BoardPrice | null, home: BoardPrice | null }
  total: { over: BoardPrice | null, under: BoardPrice | null }
  books: string[]
  updatedAt: string | null
}

interface Row {
  book: string
  market_type: string
  line: number | string | null
  side: string
  point: number | string | null
  price: number | string
  updated_at: string | Date | null
}

const num = (value: number | string | null): number | null => value === null || value === '' ? null : Number(value)

function rank(book: string): number {
  const index = PREFERENCE.indexOf(book)
  return index === -1 ? PREFERENCE.length : index
}

/** The feed's event for an ESPN game, through the link ESPN's schedule recorded. */
async function eventFor(db: Database, espnId: string): Promise<number | null> {
  const row = await db.prepare<{ id: number | string }>(`
    SELECT es.market_event_id AS id
    FROM event_sources es
    JOIN market_events e ON e.id = es.market_event_id
    WHERE es.provider = 'espn' AND es.external_id = ? AND e.status <> 'cancelled'
    ORDER BY es.market_event_id
    LIMIT 1
  `).get(espnId)
  return row ? Number(row.id) : null
}

/**
 * The main line of a two-sided ladder, from one book: the line whose sides
 * are closest to even, judged by implied probability.
 */
export function mainLine(rows: Row[], sides: [string, string]): Map<string, BoardPrice> | null {
  const byBookLine = new Map<string, Map<string, Row>>()
  for (const row of rows) {
    const key = `${row.book}|${num(row.line)}`
    const sidesHere = byBookLine.get(key) ?? new Map<string, Row>()
    sidesHere.set(row.side, row)
    byBookLine.set(key, sidesHere)
  }

  let best: { gap: number, rank: number, pair: Map<string, Row> } | null = null
  for (const pair of byBookLine.values()) {
    const a = pair.get(sides[0])
    const b = pair.get(sides[1])
    if (!a || !b)
      continue
    const gap = Math.abs(1 / Number(a.price) - 1 / Number(b.price))
    const bookRank = rank(a.book)
    if (!best || bookRank < best.rank || (bookRank === best.rank && gap < best.gap))
      best = { gap, rank: bookRank, pair }
  }
  if (!best)
    return null
  return new Map([...best.pair].map(([side, row]) => [side, { price: Number(row.price), book: row.book, point: num(row.point) }]))
}

export async function gameBoard(db: Database, espnId: string): Promise<GameBoard | null> {
  const eventId = await eventFor(db, espnId)
  if (eventId === null)
    return null

  const rows = await db.prepare<Row>(`
    SELECT b.slug AS book, m.market_type, m.line, sel.side, o.point, o.price, o.updated_at
    FROM odds o
    JOIN bookmakers b ON b.id = o.bookmaker_id
    JOIN selections sel ON sel.id = o.selection_id
    JOIN markets m ON m.id = sel.market_id
    WHERE m.market_event_id = ? AND m.period = 'full_game' AND m.player_name = ''
      AND m.market_type IN ('h2h', 'spreads', 'totals') AND o.available = 1
  `).all(eventId)
  if (rows.length === 0)
    return null

  const winnerRows = rows.filter(row => row.market_type === 'h2h').sort((a, b) => rank(a.book) - rank(b.book))
  const winnerBook = winnerRows[0]?.book
  const winner = (side: string): BoardPrice | null => {
    const row = winnerRows.find(r => r.book === winnerBook && r.side === side)
    return row ? { price: Number(row.price), book: row.book, point: null } : null
  }

  const spread = mainLine(rows.filter(row => row.market_type === 'spreads'), ['away', 'home'])
  const total = mainLine(rows.filter(row => row.market_type === 'totals'), ['over', 'under'])

  const updated = rows.map(row => row.updated_at ? new Date(row.updated_at instanceof Date ? row.updated_at : `${String(row.updated_at).replace(' ', 'T')}Z`).getTime() : 0)
  const latest = Math.max(...updated)

  return {
    winner: { away: winner('away'), home: winner('home'), draw: winner('draw') },
    spread: { away: spread?.get('away') ?? null, home: spread?.get('home') ?? null },
    total: { over: total?.get('over') ?? null, under: total?.get('under') ?? null },
    books: [...new Set(rows.map(row => row.book))].sort((a, b) => rank(a) - rank(b)),
    updatedAt: Number.isFinite(latest) && latest > 0 ? new Date(latest).toISOString() : null,
  }
}
