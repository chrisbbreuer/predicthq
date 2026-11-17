import type { Database } from '../../Support/db'

/**
 * The live half of our odds feed: every price change, as it is stored.
 *
 * `odds_snapshots` gets a row only when a price actually moves, and its ids
 * only grow, so "everything after id N" is both the update stream and a
 * resumable cursor. A client that drops and reconnects with the last id it
 * saw (`Last-Event-ID`, which `EventSource` sends on its own) misses
 * nothing and sees nothing twice.
 */

export interface StreamFilter {
  sport?: string
  books?: string[]
  eventId?: number
  marketType?: string
}

export interface PriceChange {
  id: number
  at: string
  sport: string
  book: string
  event: { id: number, title: string, commenceAt: string }
  market: { id: number, type: string, line: number | null, period: string }
  selection: { id: number, side: string, label: string, point: number | null }
  price: number
  impliedProb: number
  opening: boolean
}

interface ChangeRow {
  id: number | string
  captured_at: string
  sport: string
  book: string
  event_id: number | string
  title: string
  commence_at: string
  market_id: number | string
  market_type: string
  line: number | string | null
  period: string
  selection_id: number | string
  side: string
  label: string
  point: number | string | null
  price: number | string
  implied_prob: number | string
  is_opening: number | string
}

const num = (value: number | string | null): number | null => value === null || value === '' ? null : Number(value)

/** Changes after `cursor`, oldest first, at most `limit`. */
export async function changesAfter(db: Database, cursor: number, filter: StreamFilter = {}, limit = 500): Promise<PriceChange[]> {
  const where = ['s.id > ?']
  const params: unknown[] = [cursor]
  if (filter.sport) {
    where.push('sp.slug = ?')
    params.push(filter.sport)
  }
  if (filter.books?.length) {
    where.push(`b.slug IN (${filter.books.map(() => '?').join(', ')})`)
    params.push(...filter.books)
  }
  if (filter.eventId) {
    where.push('e.id = ?')
    params.push(filter.eventId)
  }
  if (filter.marketType) {
    where.push('m.market_type = ?')
    params.push(filter.marketType)
  }

  const rows = await db.prepare<ChangeRow>(`
    SELECT s.id, s.captured_at, sp.slug AS sport, b.slug AS book,
      e.id AS event_id, e.title, e.commence_at,
      m.id AS market_id, m.market_type, m.line, m.period,
      sel.id AS selection_id, sel.side, sel.label, s.point,
      s.price, s.implied_prob, s.is_opening
    FROM odds_snapshots s
    JOIN bookmakers b ON b.id = s.bookmaker_id
    JOIN selections sel ON sel.id = s.selection_id
    JOIN markets m ON m.id = sel.market_id
    JOIN market_events e ON e.id = m.market_event_id
    JOIN sports sp ON sp.id = e.sport_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.id ASC
    LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}
  `).all(...params)

  return rows.map(row => ({
    id: Number(row.id),
    at: row.captured_at,
    sport: row.sport,
    book: row.book,
    event: { id: Number(row.event_id), title: row.title, commenceAt: row.commence_at },
    market: { id: Number(row.market_id), type: row.market_type, line: num(row.line), period: row.period },
    selection: { id: Number(row.selection_id), side: row.side, label: row.label, point: num(row.point) },
    price: Number(row.price),
    impliedProb: Number(row.implied_prob),
    opening: Number(row.is_opening) === 1,
  }))
}

/** The newest change id, where a stream with no cursor starts. */
export async function latestChangeId(db: Database): Promise<number> {
  const row = await db.prepare<{ id: number | string | null }>('SELECT MAX(id) AS id FROM odds_snapshots').get()
  return Number(row?.id ?? 0) || 0
}

/** One server-sent event. */
export function sseFrame(change: PriceChange): string {
  return `id: ${change.id}\nevent: price\ndata: ${JSON.stringify(change)}\n\n`
}
