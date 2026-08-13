import type { Database } from '../../Support/db'

/**
 * Line movement features.
 *
 * How a price got where it is carries information the price alone does
 * not. A market that opened at 2.00 and drifted to 1.80 over three days is
 * a different object from one that sat at 2.00 and collapsed to 1.80 in
 * four minutes, even though both now read 1.80 — the second is money
 * arriving with conviction, the first is a slow re-rating.
 *
 * Everything here is derived from `odds_snapshots`, which is a change log,
 * so "no rows in the window" means genuinely no movement rather than
 * missing data.
 */

/** Lookback for velocity and steam. Long enough to see a move, short enough to be current. */
const WINDOW_HOURS = 6

/**
 * Fraction of books that must move the same way within the window before
 * it counts as steam.
 *
 * Set high on purpose. Two books drifting together is ordinary noise;
 * coordinated movement across most of the market is the thing worth
 * naming, and a low threshold would label every quiet hour as a signal.
 */
const STEAM_CONSENSUS = 0.6

export interface MovementFeatures {
  openPrice: number
  currentPrice: number
  moveFromOpenPct: number
  velocityPctPerHour: number
  steamScore: number
  directionChanges: number
  priceStdDev: number
}

interface SnapshotRow {
  bookmaker_id: number
  price: number
  captured_at: string
}

type RawSnapshotRow = Omit<SnapshotRow, 'price'> & { price: number | string }

/**
 * Movement features for one selection.
 *
 * Computed from the best-priced book's history for direction, and across
 * all books for steam — a single book moving is that book repricing, while
 * many books moving together is the market repricing.
 */
export async function movementFor(db: Database, selectionId: number, windowHours = WINDOW_HOURS): Promise<MovementFeatures> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString()

  const rawHistory = await db.query<RawSnapshotRow>(`
    SELECT bookmaker_id, price, captured_at
    FROM odds_snapshots
    WHERE selection_id = ?
    ORDER BY captured_at ASC, id ASC
  `).all(selectionId)
  // MySQL/Vitess returns DECIMAL columns as strings to avoid precision loss.
  // Prices are deliberately low-precision market values, so normalize them
  // before arithmetic and ignore corrupt/non-positive quotes.
  const history: SnapshotRow[] = rawHistory
    .map(row => ({ ...row, price: Number(row.price) }))
    .filter(row => Number.isFinite(row.price) && row.price > 0)

  if (history.length === 0) {
    return {
      openPrice: 0,
      currentPrice: 0,
      moveFromOpenPct: 0,
      velocityPctPerHour: 0,
      steamScore: 0,
      directionChanges: 0,
      priceStdDev: 0,
    }
  }

  // Per-book series, so one book's movement is never mistaken for the
  // market's — books enter and leave a market at different times, and a
  // naive merge would read a book joining as a price jump.
  const byBook = new Map<number, SnapshotRow[]>()
  for (const row of history) {
    const list = byBook.get(row.bookmaker_id) ?? []
    list.push(row)
    byBook.set(row.bookmaker_id, list)
  }

  // The reference series is the book with the most observations: the one
  // we have watched most closely, and therefore the least noisy.
  let reference: SnapshotRow[] = []
  for (const series of byBook.values()) {
    if (series.length > reference.length)
      reference = series
  }

  const openPrice = reference[0]?.price ?? 0
  const currentPrice = reference[reference.length - 1]?.price ?? 0
  const moveFromOpenPct = openPrice > 0 ? (currentPrice / openPrice - 1) * 100 : 0

  // Velocity over the window, in percent per hour.
  const windowed = reference.filter(r => r.captured_at >= cutoff)
  let velocityPctPerHour = 0
  if (windowed.length >= 2) {
    const first = windowed[0]!
    const last = windowed[windowed.length - 1]!
    const hours = (Date.parse(last.captured_at) - Date.parse(first.captured_at)) / 3_600_000
    if (hours > 0.01 && first.price > 0)
      velocityPctPerHour = ((last.price / first.price - 1) * 100) / hours
  }

  // Direction changes across the full series: a market that cannot settle
  // on a price is uncertain in a way a single net move conceals.
  let directionChanges = 0
  let lastDirection = 0
  for (let i = 1; i < reference.length; i++) {
    const delta = reference[i]!.price - reference[i - 1]!.price
    const direction = delta > 0 ? 1 : (delta < 0 ? -1 : 0)
    if (direction !== 0) {
      if (lastDirection !== 0 && direction !== lastDirection)
        directionChanges++
      lastDirection = direction
    }
  }

  // Steam: what share of books moved the same way inside the window.
  let movedUp = 0
  let movedDown = 0
  let booksWithWindow = 0
  for (const series of byBook.values()) {
    const inWindow = series.filter(r => r.captured_at >= cutoff)
    if (inWindow.length < 2)
      continue
    booksWithWindow++
    const delta = inWindow[inWindow.length - 1]!.price - inWindow[0]!.price
    if (delta > 0)
      movedUp++
    else if (delta < 0)
      movedDown++
  }

  let steamScore = 0
  if (booksWithWindow > 0) {
    const share = Math.max(movedUp, movedDown) / booksWithWindow
    // Rescale so the threshold is the zero point: below consensus is not
    // weak steam, it is no steam, and reporting it as 0.4 invites a caller
    // to treat noise as a faint signal.
    steamScore = share >= STEAM_CONSENSUS ? (share - STEAM_CONSENSUS) / (1 - STEAM_CONSENSUS) : 0
  }

  // Dispersion of current prices across books — wide disagreement is both
  // an opportunity and a warning that someone is holding stale numbers.
  const latest: number[] = []
  for (const series of byBook.values()) {
    const last = series[series.length - 1]
    if (last)
      latest.push(last.price)
  }
  const priceStdDev = stdDev(latest)

  return {
    openPrice,
    currentPrice,
    moveFromOpenPct,
    velocityPctPerHour,
    steamScore,
    directionChanges,
    priceStdDev,
  }
}

function stdDev(values: number[]): number {
  if (values.length < 2)
    return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export interface MoveRow {
  selectionId: number
  marketEventId: number
  title: string
  league: string
  pick: string
  side: string
  marketType: string
  book: string
  bookSlug: string
  from: number
  to: number
  dir: 'up' | 'down'
  movePct: number
  at: string
}

/**
 * The most recent price moves across every book, newest first.
 *
 * Uses a window function to pick each quote's latest two observations in
 * the database rather than pulling a fixed slab of rows and deduplicating
 * in application code — the previous approach read 6,000 rows on every
 * call regardless of how many had actually moved, and silently missed
 * moves once the tape outgrew that slab.
 */
export async function recentMoves(db: Database, limit = 40): Promise<MoveRow[]> {
  const rows = await db.query<Record<string, any>>(`
    WITH ranked AS (
      SELECT
        os.selection_id, os.bookmaker_id, os.price, os.captured_at,
        ROW_NUMBER() OVER (
          PARTITION BY os.selection_id, os.bookmaker_id
          ORDER BY os.captured_at DESC, os.id DESC
        ) AS rn
      FROM odds_snapshots os
    ),
    pairs AS (
      SELECT
        latest.selection_id,
        latest.bookmaker_id,
        prev.price AS from_price,
        latest.price AS to_price,
        latest.captured_at AS at
      FROM ranked latest
      JOIN ranked prev
        ON prev.selection_id = latest.selection_id
      AND prev.bookmaker_id = latest.bookmaker_id
      AND prev.rn = 2
      WHERE latest.rn = 1 AND latest.price != prev.price
    )
    SELECT
      p.selection_id, p.from_price, p.to_price, p.at,
      s.label AS pick, s.side,
      m.market_type,
      e.id AS market_event_id, e.title, e.league,
      b.name AS book, b.slug AS book_slug
    FROM pairs p
    JOIN selections s ON s.id = p.selection_id
    JOIN markets m ON m.id = s.market_id
    JOIN market_events e ON e.id = m.market_event_id
    JOIN bookmakers b ON b.id = p.bookmaker_id
    ORDER BY p.at DESC
    LIMIT ?
  `).all(limit)

  return rows.map(r => ({
    selectionId: r.selection_id,
    marketEventId: r.market_event_id,
    title: r.title,
    league: r.league,
    pick: r.pick,
    side: r.side,
    marketType: r.market_type,
    book: r.book,
    bookSlug: r.book_slug,
    from: r.from_price,
    to: r.to_price,
    dir: r.to_price > r.from_price ? 'up' : 'down',
    movePct: r.from_price > 0 ? (r.to_price / r.from_price - 1) * 100 : 0,
    at: r.at,
  }))
}

export { STEAM_CONSENSUS, WINDOW_HOURS }
