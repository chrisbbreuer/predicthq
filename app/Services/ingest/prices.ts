import type { Database } from '../../Support/db'
import { impliedProbability, nowIso, toAmericanNumber } from '../../Support/keys'

/**
 * The single writer for prices.
 *
 * Every odds source funnels through here so the current-price row, the
 * history row, and the derived columns can never disagree. When each
 * provider wrote its own SQL it was possible — and it happened — for a
 * price to update without a matching snapshot, which makes the line look
 * as though it never moved.
 */

export interface PriceWrite {
  selectionId: number
  bookmakerId: number
  /** Decimal odds. */
  price: number
  point?: number | null
  limitAmount?: number
  available?: boolean
  /** Provider's own timestamp for the quote, if it publishes one. */
  observedAt?: string
  /** Identifies the ingest source for an independently checked sportsbook offer. */
  historySource?: string
  historyCheckedAt?: string
  /** Deep link to this selection on the book's own site. */
  link?: string
  /** The book's own id for this outcome. */
  sid?: string
  /** Money matched at this price on an exchange. Zero for a sportsbook. */
  tradedVolume?: number
}

export interface PriceWriteResult {
  written: number
  changed: number
  snapshots: number
}

/**
 * How many rows go into one statement.
 *
 * Bounded for two reasons: a multi-row INSERT eventually exceeds MySQL's
 * `max_allowed_packet`, and an `IN (…)` list of unbounded length stops
 * being a usable query plan. Five hundred is comfortably inside both while
 * still turning a full board into a handful of round trips.
 */
const PRICE_BATCH = 500
const observationInterval = 5 * 60_000

function instant(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value
  return Date.parse(iso)
}

interface PriorPrice {
  price: number
  point: number | null
  available: boolean
  updatedAt: string
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

function priceKey(selectionId: number, bookmakerId: number): string {
  return `${selectionId}:${bookmakerId}`
}

/**
 * The prices we already hold for everything in this batch, in one read.
 *
 * Keyed on selection alone rather than the selection/bookmaker pair: a
 * row-constructor `IN` is spelled differently on every dialect we run on,
 * and the extra rows this pulls back are the other books' quotes on
 * selections we are already writing — cheap, and filtered in memory.
 */
async function loadPriorPrices(
  db: Database,
  writes: PriceWrite[],
): Promise<Map<string, PriorPrice>> {
  const prior = new Map<string, PriorPrice>()
  const selectionIds = [...new Set(writes.map(w => w.selectionId))]

  for (const group of chunk(selectionIds, PRICE_BATCH)) {
    const placeholders = group.map(() => '?').join(', ')
    const rows = await db.query<{ selection_id: number, bookmaker_id: number, price: number, point: number | null, available: number, updated_at: string }>(
      `SELECT selection_id, bookmaker_id, price, point, available, updated_at FROM odds WHERE selection_id IN (${placeholders})`,
    ).all(...group)

    for (const row of rows) {
      prior.set(priceKey(Number(row.selection_id), Number(row.bookmaker_id)), {
        price: Number(row.price),
        point: row.point === null || row.point === undefined ? null : Number(row.point),
        available: Number(row.available) === 1,
        updatedAt: row.updated_at,
      })
    }
  }

  return prior
}

/** Columns a colliding `odds` row takes from the incoming quote. */
const ODDS_MERGE_COLUMNS = [
  'price',
  'american',
  'implied_prob',
  'point',
  'limit_amount',
  'available',
  'observed_at',
  'link',
  'sid',
  'traded_volume',
  'updated_at',
]

/**
 * Upsert current prices and append history for the ones that moved.
 *
 * History is appended **only on change**. Snapshotting every poll would
 * add a row per quote per minute — billions a season — while telling us
 * nothing a change log doesn't: the price between two observations is by
 * definition the earlier one.
 *
 * `captured_at` deliberately reuses a single `now` for the whole batch.
 * The unique index on (selection, bookmaker, captured_at) then makes a
 * retried or overlapping pass idempotent rather than letting it write a
 * second identical observation that would read as a movement of zero.
 *
 * ### Why this is batched
 *
 * It used to run a `SELECT`, an upsert, and for a moved price a second
 * `SELECT` and an insert — per quote. Two to four round trips times
 * thousands of selections times every book was affordable at one pass
 * every five minutes and is not affordable at one pass a second, which is
 * what the realtime engine asks for. The work is identical; it now travels
 * in three statements per chunk instead of four per row.
 */
/** A number at the two decimals the price columns store. */
function toCents(value: number): number {
  return Math.round(value * 100) / 100
}

export async function writePrices(db: Database, writes: PriceWrite[], now = nowIso()): Promise<PriceWriteResult> {

  // Last quote wins. The same selection and book arriving twice in one
  // batch is a provider repeating an event, and carrying both into a
  // multi-row upsert is a portability trap: MySQL silently keeps the last
  // while Postgres and SQLite reject the whole statement.
  const latest = new Map<string, PriceWrite & { rawPrice: number }>()
  for (const w of writes) {
    if (!Number.isFinite(w.price))
      continue
    // `odds.price` and `point` hold two decimals. Comparing a stored 1.61
    // with an incoming 1.6129 would call every pass a move and write a
    // snapshot each time, so prices are put at the stored precision first.
    const price = toCents(w.price)
    if (price <= 1)
      continue
    latest.set(priceKey(w.selectionId, w.bookmakerId), { ...w, rawPrice: w.price, price, point: w.point === null || w.point === undefined ? w.point : toCents(w.point) })
  }

  const pending = [...latest.values()]
  if (pending.length === 0)
    return { written: 0, changed: 0, snapshots: 0 }

  const prior = await loadPriorPrices(db, pending)

  const oddsRows: Record<string, unknown>[] = []
  const snapshotRows: Record<string, unknown>[] = []
  const observations: Record<string, unknown>[] = []
  let changed = 0

  for (const w of pending) {
    const point = w.point ?? null
    const implied = impliedProbability(w.price)
    const was = prior.get(priceKey(w.selectionId, w.bookmakerId)) ?? null
    const checkedAt = w.historyCheckedAt || now
    const checkedAtMs = instant(checkedAt)
    const priorCheck = was ? instant(was.updatedAt) : Number.NaN
    if (w.historyCheckedAt && checkedAtMs < priorCheck)
      continue

    oddsRows.push({
      selection_id: w.selectionId,
      bookmaker_id: w.bookmakerId,
      price: w.price,
      american: toAmericanNumber(w.price),
      implied_prob: implied,
      point,
      limit_amount: w.limitAmount ?? 0,
      available: w.available === false ? 0 : 1,
      observed_at: w.observedAt || now,
      link: w.link ?? '',
      sid: w.sid ?? '',
      traded_volume: w.tradedVolume ?? 0,
      updated_at: checkedAt,
    })

    const moved = was === null || was.price !== w.price || was.point !== point
    const available = w.available !== false
    if (w.historySource && Number.isFinite(checkedAtMs)
      && (moved || was?.available !== available || Math.floor(priorCheck / observationInterval) !== Math.floor(checkedAtMs / observationInterval))) {
      observations.push({
        selection_id: w.selectionId,
        bookmaker_id: w.bookmakerId,
        checked_at_ms: checkedAtMs,
        observed_at: w.observedAt || null,
        price: w.rawPrice,
        point,
        available: Number(available),
        source: w.historySource,
      })
    }
    if (!moved)
      continue

    changed++
    snapshotRows.push({
      selection_id: w.selectionId,
      bookmaker_id: w.bookmakerId,
      price: w.price,
      implied_prob: implied,
      point,
      captured_at: now,
      is_opening: was === null ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
  }

  for (const group of chunk(oddsRows, PRICE_BATCH))
    await db.upsert('odds', group, ['selection_id', 'bookmaker_id'], ODDS_MERGE_COLUMNS)

  // No merge columns: a snapshot that already exists at this timestamp is
  // the idempotency guarantee working, not something to overwrite. The
  // ignore form's affected-row count is exactly how many landed.
  let snapshots = 0
  for (const group of chunk(snapshotRows, PRICE_BATCH))
    snapshots += (await db.upsert('odds_snapshots', group, ['selection_id', 'bookmaker_id', 'captured_at'])).changes
  for (const group of chunk(observations, PRICE_BATCH))
    await db.upsert('sportsbook_quote_observations', group, ['selection_id', 'bookmaker_id', 'checked_at_ms'])

  return { written: oddsRows.length, changed, snapshots }
}

/** One observation that a book offers a market on an event. */
export interface CoverageWrite {
  bookmakerId: number
  marketEventId: number
  marketType: string
}

/**
 * Record what each book is offering, separately from what it is pricing.
 *
 * The two questions look identical through the `odds` table and are not.
 * A book that pulled its player props ten minutes before kickoff and a
 * book that never offered them both have no prop prices; the first is a
 * market closing, which is information, and the second is a gap in our
 * coverage, which is a bug. Only a record of the *offer* separates them.
 *
 * `lastSeenAt` is the whole payload, so a market that stops appearing ages
 * out visibly rather than lingering as a claim we can no longer support.
 * Repeats within one pass are collapsed for the same reason `writePrices`
 * dedupes: a duplicate conflict key inside one multi-row statement is
 * tolerated by MySQL and rejected by SQLite and Postgres.
 */
export async function writeCoverage(db: Database, entries: CoverageWrite[]): Promise<number> {
  if (entries.length === 0)
    return 0

  const now = nowIso()
  const rows = new Map<string, Record<string, unknown>>()

  for (const entry of entries) {
    const key = `${entry.bookmakerId}:${entry.marketEventId}:${entry.marketType}`
    const existing = rows.get(key)

    if (existing) {
      // Each distinct line the book quotes on this market type. A single
      // main total and an alternate ladder are different amounts of
      // market, and the count is what tells them apart.
      existing.line_count = (existing.line_count as number) + 1
      continue
    }

    rows.set(key, {
      bookmaker_id: entry.bookmakerId,
      market_event_id: entry.marketEventId,
      market_type: entry.marketType,
      line_count: 1,
      last_seen_at: now,
      updated_at: now,
    })
  }

  const list = [...rows.values()]

  for (const group of chunk(list, PRICE_BATCH)) {
    await db.upsert(
      'book_market_coverage',
      group,
      ['bookmaker_id', 'market_event_id', 'market_type'],
      ['line_count', 'last_seen_at', 'updated_at'],
    )
  }

  return list.length
}

/**
 * Map a bookmaker's provider key (or slug, or name) to its row id.
 *
 * Built once per pass. Every spelling points at the same id, so a feed
 * that changes how it identifies a book keeps matching — the failure mode
 * this replaces silently dropped that book's prices entirely.
 */
export async function loadBookmakerIndex(db: Database) {
  const rows = await db
    .query<{ id: number, name: string, slug: string, provider_key: string, kind: string }>('SELECT id, name, slug, provider_key, kind FROM bookmakers WHERE active = 1')
    .all()

  const index = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    for (const key of [row.provider_key, row.slug, row.name]) {
      if (key) {
        const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (k && !index.has(k))
          index.set(k, row)
      }
    }
  }
  return index
}
