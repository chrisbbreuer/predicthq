import type { Database } from '../../Support/db'
import type { FeedEvent, OddsProvider } from '../odds/provider'
import type { BookAdapter, BookContext } from '../odds/books/adapter'
import type { CoverageWrite, PriceWrite } from './prices'
import type { SportRow } from './resolve'
import process from 'node:process'
import { sportEnabled } from '../../../config/odds'
import { SyntheticProvider } from '../odds/synthetic'
import { activeAdapters } from '../odds/books'
import { bookContextFor } from '../odds/context'
import { CompositeProvider } from '../odds/composite'
import { NativeProvider } from '../odds/native'
import { TheOddsApiProvider } from '../odds/the-odds-api'
import { loadBookmakerIndex, writeCoverage, writePrices } from './prices'
import { loadSports, resolveEvent, resolveMarket, resolveSelection, resolveTeam } from './resolve'
import { IngestRunTracker } from './run'

/**
 * Persist a normalized odds feed.
 *
 * The whole pass runs in one transaction. Ingestion touches thousands of
 * rows across five tables, and a half-applied pass is worse than a skipped
 * one: markets without selections, or selections whose prices never
 * arrived, read downstream as "this market has no line" rather than as an
 * error.
 */

/** Human labels for the bet types, so the UI needs no lookup table. */
const MARKET_LABELS: Record<string, string> = {
  h2h: 'Moneyline',
  spreads: 'Spread',
  totals: 'Total',
}

/**
 * Leagues this pass should ask a bookmaker about.
 *
 * Two gates, and they answer different questions. `active` on the model
 * says whether we track the league at all; `sportEnabled` says whether
 * bookmaker prices are wanted for it right now, which is an operational
 * choice and lives in `config/odds.ts`. Keeping them apart means turning
 * off polling does not look like deleting a league.
 */
export async function pollableSports(db: Database): Promise<SportRow[]> {
  return (await loadSports(db)).filter(sport => sportEnabled(sport.slug))
}

/**
 * One provider graph for every runtime path: native books first, paid feed
 * only for leagues that produced no native events. The scheduler and the
 * realtime watcher both call this logic, so one cannot quietly invert the
 * priority of the other.
 *
 * The fallback is recorded loudly in the run row rather than hidden. A
 * synthetic board that looks live is exactly how the previous system
 * concealed a feed that had never matched anything.
 *
 * The paid feed additionally needs a league it has a key for. That is a
 * property of the provider, not of the league, so it is filtered here
 * rather than in `pollableSports` — a book adapter covering a league The
 * Odds API does not is a case we expect to have shortly.
 */
export async function resolveProvider(db: Database): Promise<OddsProvider> {
  const key = process.env.ODDS_API_KEY
  const sports = await pollableSports(db)
  const adapters = activeAdapters()

  if (adapters.length > 0 || key) {
    return nativeFirstOddsProvider(
      sports,
      adapters,
      (adapter, tracker) => bookContextFor(adapter, tracker),
      key,
    )
  }

  return new SyntheticProvider(db)
}

/** Build the native-first/fallback graph for a specific set of due leagues. */
export function nativeFirstOddsProvider(
  sports: SportRow[],
  adapters: BookAdapter[],
  contextFor: (adapter: BookAdapter, tracker: IngestRunTracker) => BookContext,
  apiKey: string | undefined = process.env.ODDS_API_KEY,
): OddsProvider {
  const native = new NativeProvider(adapters, sports, contextFor)
  if (!apiKey)
    return native

  return new CompositeProvider(native, sports, (missing) => {
    const supported = missing.filter(sport => sport.odds_api_key)
    if (supported.length === 0)
      return null

    return new TheOddsApiProvider(apiKey, supported, {
      // Request the books whose direct adapters failed. This both mirrors
      // native coverage and is cheaper than buying every regional book.
      bookmakersForSport: sportSlug => adapters
        .filter(adapter => adapter.sports.includes(sportSlug))
        .map(adapter => adapter.slug),
    })
  })
}

export interface OddsIngestResult {
  provider: string
  /** Leagues that produced no native events and invoked the paid backup. */
  fallbackSports: string[]
  status: string
  events: number
  markets: number
  selections: number
  pricesWritten: number
  pricesChanged: number
  snapshots: number
  unmatched: number
  quotaRemaining: number
  errors: string[]
}

export async function ingestOdds(db: Database, provider?: OddsProvider): Promise<OddsIngestResult> {
  const active = provider ?? await resolveProvider(db)
  const tracker = new IngestRunTracker(db, active.name, 'odds')
  await tracker.start()

  let feed: FeedEvent[] = []
  try {
    feed = await active.fetchEvents(tracker)
  }
  catch (err) {
    tracker.fail(err instanceof Error ? err.message : String(err))
  }

  const bookIndex = await loadBookmakerIndex(db)
  const sportBySlug = new Map((await loadSports(db)).map(s => [s.slug, s]))

  let markets = 0
  let selections = 0
  const writes: PriceWrite[] = []
  const coverage: CoverageWrite[] = []

  try {
    const result = await db.transaction(async (transaction) => {
      for (const event of feed) {
      const sport = sportBySlug.get(event.sportSlug)
      if (!sport) {
        tracker.unmatchedCount++
        continue
      }

        const homeTeamId = await resolveTeam(transaction, sport.id, event.homeTeam)
        const awayTeamId = await resolveTeam(transaction, sport.id, event.awayTeam)

        const { eventId } = await resolveEvent(transaction, {
        sportId: sport.id,
        provider: active.name,
        externalId: event.externalId,
        title: `${event.awayTeam} at ${event.homeTeam}`,
        commenceAt: event.commenceAt,
        homeTeamId,
        awayTeamId,
        category: sport.grouping,
        league: sport.title,
      })

      for (const book of event.books) {
        const bookmakerId = bookIndex.get(book.key.toLowerCase().replace(/[^a-z0-9]/g, ''))
        if (bookmakerId === undefined) {
          // A book we do not carry. Counted rather than logged per row —
          // an unseeded book produces one of these per event per pass, and
          // the count makes the gap visible without the noise.
          tracker.unmatchedCount++
          continue
        }

        for (const market of book.markets) {
          const marketId = await resolveMarket(transaction, {
            eventId,
            marketType: market.marketType,
            line: market.line,
            period: market.period ?? 'full_game',
            label: MARKET_LABELS[market.marketType] ?? market.marketType,
            playerName: market.playerName,
            // Two- and three-way markets partition the outcome space;
            // anything else may not, and only a complete market has a
            // meaningful hold or arbitrage reading.
            complete: market.outcomes.length >= 2,
          })
          markets++

          // What this book offers, recorded separately from what it is
          // currently pricing. A book that pulled its props before kickoff
          // and a book that never offered them look identical through the
          // odds table, and only the first is normal.
          coverage.push({ bookmakerId, marketEventId: eventId, marketType: market.marketType })

          for (const [index, outcome] of market.outcomes.entries()) {
            const selectionId = await resolveSelection(transaction, {
              marketId,
              label: outcome.label,
              side: outcome.side,
              point: outcome.point,
              position: index,
              sportsTeamId: outcome.side === 'home' ? homeTeamId : (outcome.side === 'away' ? awayTeamId : null),
            })
            selections++

            writes.push({
              selectionId,
              bookmakerId,
              price: outcome.price,
              point: outcome.point,
              limitAmount: outcome.limitAmount,
              link: outcome.link,
              sid: outcome.sid,
              tradedVolume: outcome.tradedVolume,
              observedAt: book.lastUpdate,
            })
            tracker.rowsRead++
          }
        }
      }
      }

      await writeCoverage(transaction, coverage)
      return await writePrices(transaction, writes)
    })
    tracker.rowsWritten = result.written

    const fallbackSports = active instanceof CompositeProvider ? active.fallbackSports() : []
    const fallbackSummary = fallbackSports.length > 0 ? ` · fallback ${fallbackSports.join(', ')}` : ''
    const summary = `${feed.length} events · ${markets} markets · ${result.written} prices (${result.changed} moved)${fallbackSummary}`
    const { status, errors } = await tracker.finish(summary)

    return {
      provider: active.name,
      fallbackSports,
      status,
      events: feed.length,
      markets,
      selections,
      pricesWritten: result.written,
      pricesChanged: result.changed,
      snapshots: result.snapshots,
      unmatched: tracker.unmatchedCount,
      quotaRemaining: tracker.quotaRemaining,
      errors,
    }
  }
  catch (err) {
    tracker.fail(err instanceof Error ? err.message : String(err))
    const { status, errors } = await tracker.finish('failed')
    return {
      provider: active.name,
      fallbackSports: active instanceof CompositeProvider ? active.fallbackSports() : [],
      status,
      events: feed.length,
      markets: 0,
      selections: 0,
      pricesWritten: 0,
      pricesChanged: 0,
      snapshots: 0,
      unmatched: tracker.unmatchedCount,
      quotaRemaining: tracker.quotaRemaining,
      errors,
    }
  }
}
