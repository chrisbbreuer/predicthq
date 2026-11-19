import type { Database } from '../../Support/db'

/**
 * Reconstructing the board as it stood at an instant.
 *
 * `odds_snapshots` is a change log, not a series of board states: a row
 * exists only where a price moved. That is what makes a season of history
 * affordable — snapshotting every poll would add a row per quote per pass,
 * billions a season, while telling us nothing, since the price between two
 * observations is by definition the earlier one.
 *
 * The consequence is that "the board at 14:32" has to be derived: for each
 * selection and book, the latest observation at or before that instant.
 * That is one grouped read rather than a lookup, and it is the reason this
 * lives here rather than being a `SELECT ... WHERE captured_at = ?`.
 */

export interface HistoricalQuote {
  eventId: number
  eventTitle: string
  sportSlug: string
  commenceAt: string
  marketType: string
  line: number | null
  playerName: string
  selectionId: number
  selectionLabel: string
  side: string
  bookmaker: string
  price: number
  impliedProb: number
  point: number | null
  capturedAt: string
  observedAt?: string | null
  source?: string
}

export interface HistoricalQuery {
  /** ISO instant to reconstruct at. */
  at: string
  /** Optional league filter, by our slug. */
  sportSlug?: string
  limit: number
  /** Return independently checked sportsbook quotes inside this age limit. */
  maxAgeMinutes?: number
}

export async function historicalBoard(db: Database, query: HistoricalQuery): Promise<HistoricalQuote[]> {
  if (query.maxAgeMinutes !== undefined)
    return confirmedSportsbookBoard(db, query, query.maxAgeMinutes)
  const params: Array<string | number> = [query.at]

  let sportFilter = ''
  if (query.sportSlug) {
    sportFilter = 'AND sp.slug = ?'
    params.push(query.sportSlug)
  }

  params.push(query.limit)

  // The correlated subquery picks each (selection, book) pair's latest
  // observation at or before `at`. Joining on the timestamp rather than
  // taking a MAX over the row would return columns from mixed rows on any
  // engine that permits it, which is how a price gets paired with another
  // observation's line.
  return await db.query<HistoricalQuote>(`
    SELECT
      e.id            AS eventId,
      e.title         AS eventTitle,
      sp.slug         AS sportSlug,
      e.commence_at   AS commenceAt,
      m.market_type   AS marketType,
      m.line          AS line,
      m.player_name   AS playerName,
      s.id            AS selectionId,
      s.label         AS selectionLabel,
      s.side          AS side,
      b.slug          AS bookmaker,
      os.price        AS price,
      os.implied_prob AS impliedProb,
      os.point        AS point,
      os.captured_at  AS capturedAt
    FROM odds_snapshots os
    JOIN selections s     ON s.id = os.selection_id
    JOIN markets m        ON m.id = s.market_id
    JOIN market_events e  ON e.id = m.market_event_id
    JOIN sports sp        ON sp.id = e.sport_id
    JOIN bookmakers b     ON b.id = os.bookmaker_id
    WHERE os.captured_at = (
      SELECT MAX(inner_os.captured_at)
      FROM odds_snapshots inner_os
      WHERE inner_os.selection_id = os.selection_id
        AND inner_os.bookmaker_id = os.bookmaker_id
        AND inner_os.captured_at <= ?
    )
    ${sportFilter}
    ORDER BY e.commence_at ASC, e.id ASC, m.id ASC, s.position ASC
    LIMIT ?
  `).all(...params)
}

async function confirmedSportsbookBoard(db: Database, query: HistoricalQuery, maxAgeMinutes: number): Promise<HistoricalQuote[]> {
  const at = Date.parse(query.at)
  const params: Array<string | number> = [at - maxAgeMinutes * 60_000, at, at]
  const sportFilter = query.sportSlug ? 'AND sp.slug = ?' : ''
  if (query.sportSlug)
    params.push(query.sportSlug)
  params.push(query.limit)

  const rows = await db.query<Omit<HistoricalQuote, 'capturedAt'> & { checkedAtMs: number | string }>(`
    SELECT e.id AS eventId, e.title AS eventTitle, sp.slug AS sportSlug, e.commence_at AS commenceAt,
      m.market_type AS marketType, m.line, m.player_name AS playerName,
      s.id AS selectionId, s.label AS selectionLabel, s.side, b.slug AS bookmaker,
      q.price, 1.0 / q.price AS impliedProb, q.point, q.checked_at_ms AS checkedAtMs,
      q.observed_at AS observedAt, q.source
    FROM sportsbook_quote_observations q
    JOIN selections s ON s.id = q.selection_id
    JOIN markets m ON m.id = s.market_id
    JOIN market_events e ON e.id = m.market_event_id
    JOIN sports sp ON sp.id = e.sport_id
    JOIN bookmakers b ON b.id = q.bookmaker_id
    WHERE q.checked_at_ms BETWEEN ? AND ? AND q.available = 1
      AND NOT EXISTS (
        SELECT 1 FROM sportsbook_quote_observations newer
        WHERE newer.selection_id = q.selection_id AND newer.bookmaker_id = q.bookmaker_id
          AND newer.checked_at_ms > q.checked_at_ms AND newer.checked_at_ms <= ?
      )
      ${sportFilter}
    ORDER BY e.commence_at ASC, e.id ASC, m.id ASC, s.position ASC, b.id ASC
    LIMIT ?
  `).all(...params)
  return rows.map(({ checkedAtMs, ...row }) => ({ ...row, capturedAt: new Date(Number(checkedAtMs)).toISOString() }))
}

export interface BookCoverage {
  bookmaker: string
  marketType: string
  lineCount: number
  lastSeenAt: string
}

/**
 * What each book is offering on one event.
 *
 * Answers the question the odds table cannot: a book that pulled a market
 * and a book that never had it both have no prices, and only the first is
 * normal. `lastSeenAt` is what separates them — a market that stopped
 * appearing ages visibly rather than vanishing.
 */
export async function coverageForEvent(db: Database, marketEventId: number): Promise<BookCoverage[]> {
  return await db.query<BookCoverage>(`
    SELECT
      b.slug            AS bookmaker,
      c.market_type     AS marketType,
      c.line_count      AS lineCount,
      c.last_seen_at    AS lastSeenAt
    FROM book_market_coverage c
    JOIN bookmakers b ON b.id = c.bookmaker_id
    WHERE c.market_event_id = ?
    ORDER BY b.slug ASC, c.market_type ASC
  `).all(marketEventId)
}
