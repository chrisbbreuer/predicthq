import type { Database } from '../../Support/db'
import { devig, expectedValuePct, kellyFraction } from '../../Support/devig'
import { nowIso } from '../../Support/keys'
import { STALE_LIVE_MS } from '../../../config/odds'

/**
 * Consensus fair pricing.
 *
 * Turns raw quotes into the honest numbers the product reports: what each
 * outcome's true probability is, what the best available price is, and
 * whether the gap between them is real edge or just the book's margin
 * showing through.
 *
 * ### Order of operations, and why it matters
 * De-vigging happens **per book, then blends** — never the other way
 * round. Each book sets its own margin, so averaging raw prices across
 * books first produces a blended number that still contains a blended
 * margin, and removing "the" margin from that afterwards is removing a
 * quantity that belongs to no one. Doing it in this order means every
 * input to the blend is already a genuine probability estimate.
 *
 * The blend is weighted rather than flat. A flat average across books is a
 * *worse* estimator than the sharp price alone: recreational books shade
 * toward public money and copy the market late, so including them at equal
 * weight actively drags the estimate toward the crowd. `consensusWeight`
 * on each bookmaker encodes that, and the weights live in data so a book's
 * standing can change without a deploy.
 */

/** Below this many books a "consensus" is not one; the row is still written, flagged. */
const MIN_BOOKS_FOR_CONSENSUS = 2

/** Fraction of full Kelly to report. See `kellyFraction` for the reasoning. */
const KELLY_FRACTION = 0.25

interface QuoteRow {
  selection_id: number
  bookmaker_id: number
  price: number
  market_id: number
  side: string
  sharp: number
  consensus_weight: number
}

export interface FairPriceResult {
  markets: number
  selections: number
  written: number
  /** Selections whose best available price beats consensus fair value. */
  positiveEdge: number
}

/**
 * Markets per page. Each page is one read and one transaction: a few quotes
 * per market keeps the read far under Vitess's 10,000-row cap, and a page of
 * upserts well inside its 30s transaction limit.
 */
const PAGE_MARKETS = 400

/**
 * Recompute fair prices for every market on a game still to be decided:
 * scheduled or live, and started within the last day.
 *
 * Runs after each odds ingest. A finished game is left alone: its last fair
 * price is its closing number, and re-deriving it from quotes nobody can take
 * any more would only rewrite it. The rest is walked a page of markets at a
 * time, in market-id order. A market is never split across pages, so each one
 * is de-vigged and written whole, in one transaction: a half-written market
 * would show edge on one side and stale numbers on the other, which reads as
 * a signal rather than an incomplete pass.
 *
 * The pass used to read every quote in one query and write it in one
 * transaction. Once the exchanges streamed into the feed that read passed
 * Vitess's 10,000-row cap and the whole pipeline failed on every run.
 */
export async function computeFairPrices(db: Database, options: { marketIds?: number[] } = {}): Promise<FairPriceResult> {
  const result: FairPriceResult = { markets: 0, selections: 0, written: 0, positiveEdge: 0 }
  const only = options.marketIds?.length ? `AND m.id IN (${options.marketIds.map(() => '?').join(',')})` : ''

  // A game that started more than a day ago is over, whatever its status
  // says: the schedule feed leaves fixtures it skipped `scheduled` for good.
  const since = new Date(Date.now() - STALE_LIVE_MS).toISOString()

  let after = 0
  for (;;) {
    const page = await db.query<{ id: number | string }>(`
      SELECT m.id
      FROM markets m
      JOIN market_events e ON e.id = m.market_event_id
      WHERE m.complete = 1 AND e.status IN ('scheduled', 'live') AND e.commence_at >= ? AND m.id > ? ${only}
      ORDER BY m.id ASC
      LIMIT ${PAGE_MARKETS}
    `).all(since, after, ...(options.marketIds ?? []))
    if (page.length === 0)
      break

    const ids = page.map(row => Number(row.id))
    after = ids[ids.length - 1]!
    const written = await priceMarkets(db, ids)
    result.markets += written.markets
    result.selections += written.selections
    result.written += written.written
    result.positiveEdge += written.positiveEdge

    if (page.length < PAGE_MARKETS)
      break
  }

  return result
}

/** De-vig, blend and write one page of markets, in one transaction. */
async function priceMarkets(db: Database, marketIds: number[]): Promise<FairPriceResult> {
  const raw = await db.query<QuoteRow>(`
    SELECT o.selection_id, o.bookmaker_id, o.price,
          s.market_id, s.side,
          b.sharp, b.consensus_weight
    FROM odds o
    JOIN selections s ON s.id = o.selection_id
    JOIN bookmakers b ON b.id = o.bookmaker_id
    WHERE o.available = 1 AND o.price > 1 AND s.market_id IN (${marketIds.map(() => '?').join(',')})
    ORDER BY s.market_id ASC, s.position ASC, s.id ASC
  `).all(...marketIds)

  // Vitess returns DECIMAL and BIGINT columns as strings. Comparing those
  // picks the "best" price by text, so 10.5 loses to 9.8.
  const rows: QuoteRow[] = raw.map(row => ({
    ...row,
    selection_id: Number(row.selection_id),
    bookmaker_id: Number(row.bookmaker_id),
    price: Number(row.price),
    market_id: Number(row.market_id),
    sharp: Number(row.sharp),
    consensus_weight: row.consensus_weight === null || row.consensus_weight === undefined ? 1 : Number(row.consensus_weight),
  }))

  // Group into market → book → the quotes that book offers on it. A book's
  // prices must be de-vigged together, as a set, because the margin is a
  // property of the market as that book prices it — not of one side.
  const byMarket = new Map<number, Map<number, QuoteRow[]>>()
  for (const row of rows) {
    let books = byMarket.get(row.market_id)
    if (!books) {
      books = new Map()
      byMarket.set(row.market_id, books)
    }
    const quotes = books.get(row.bookmaker_id) ?? []
    quotes.push(row)
    books.set(row.bookmaker_id, quotes)
  }

  const now = nowIso()
  let selectionsWritten = 0
  let positiveEdge = 0

  await db.transaction(async (transaction) => {
    for (const [, books] of byMarket) {
      // Accumulators keyed by selection, across every book on this market.
      const weighted = new Map<number, { consensus: number, sharp: number, mult: number, power: number, shin: number }>()
      const weights = { total: 0, sharp: 0 }
      const best = new Map<number, { price: number, bookmakerId: number }>()
      const spread = new Map<number, number>()
      let overroundSum = 0
      let bookCount = 0
      let sharpBookCount = 0

      for (const [bookmakerId, quotes] of books) {
        // A single quote is not a market — there is no complementary side
        // to remove margin against, and "de-vigging" it would just return
        // the raw implied probability wearing a fair-value label.
        if (quotes.length < 2)
          continue

        const result = devig(quotes.map(q => q.price))
        const weight = Math.max(0, quotes[0]!.consensus_weight ?? 1)
        const isSharp = quotes[0]!.sharp === 1

        bookCount++
        if (isSharp)
          sharpBookCount++
        overroundSum += result.overround
        weights.total += weight
        if (isSharp)
          weights.sharp += weight

        for (const [index, quote] of quotes.entries()) {
          const acc = weighted.get(quote.selection_id) ?? { consensus: 0, sharp: 0, mult: 0, power: 0, shin: 0 }
          // Shin is the reported default; the others are carried so the
          // disagreement between methods stays visible downstream.
          acc.consensus += (result.shin[index] ?? 0) * weight
          acc.mult += (result.multiplicative[index] ?? 0) * weight
          acc.power += (result.power[index] ?? 0) * weight
          acc.shin += (result.shin[index] ?? 0) * weight
          if (isSharp)
            acc.sharp += (result.shin[index] ?? 0) * weight
          weighted.set(quote.selection_id, acc)

          spread.set(quote.selection_id, Math.max(spread.get(quote.selection_id) ?? 0, result.methodSpread))

          const current = best.get(quote.selection_id)
          if (!current || quote.price > current.price)
            best.set(quote.selection_id, { price: quote.price, bookmakerId })
        }
      }

      if (bookCount === 0)
        continue

      // Normalizing the blend keeps it a distribution. Weighted sums of
      // several distributions are only a distribution again once divided
      // by the total weight, and skipping this would inflate every
      // probability by the weight total — turning every market into edge.
      const avgOverround = overroundSum / bookCount

      let marketFairSum = 0
      for (const [, acc] of weighted)
        marketFairSum += acc.consensus / (weights.total || 1)

      for (const [selectionId, acc] of weighted) {
        const consensus = clampProb((acc.consensus / (weights.total || 1)) / (marketFairSum || 1))
        const sharpProb = weights.sharp > 0 ? clampProb(acc.sharp / weights.sharp) : 0
        const bestQuote = best.get(selectionId)
        const bestPrice = bestQuote?.price ?? 0

        const edge = bestPrice > 1 ? expectedValuePct(bestPrice, consensus) : 0
        if (edge > 0)
          positiveEdge++

        await transaction.updateOrInsert('fair_prices', { selection_id: selectionId }, {
          prob_consensus: consensus,
          prob_sharp: sharpProb,
          prob_multiplicative: clampProb(acc.mult / (weights.total || 1)),
          prob_power: clampProb(acc.power / (weights.total || 1)),
          prob_shin: clampProb(acc.shin / (weights.total || 1)),
          method_spread: spread.get(selectionId) ?? 0,
          fair_price: consensus > 0 ? 1 / consensus : 0,
          best_price: bestPrice,
          best_bookmaker_id: bestQuote?.bookmakerId ?? null,
          edge_pct: edge,
          kelly_fraction: kellyFraction(bestPrice, consensus, KELLY_FRACTION),
          overround_pct: (avgOverround - 1) * 100,
          book_count: bookCount,
          sharp_book_count: sharpBookCount,
          computed_at: now,
          updated_at: now,
        })
        selectionsWritten++
      }
    }

  })

  return {
    markets: byMarket.size,
    selections: selectionsWritten,
    written: selectionsWritten,
    positiveEdge,
  }
}

/** Keep probabilities inside (0,1) so downstream division never explodes. */
function clampProb(p: number): number {
  if (!Number.isFinite(p))
    return 0
  return Math.min(0.999999, Math.max(0, p))
}

export { MIN_BOOKS_FOR_CONSENSUS }
