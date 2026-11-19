import type { IngestRunTracker } from '../ingest/run'

/**
 * The normalized shape every odds source produces.
 *
 * Providers differ wildly in wire format; they agree only on the thing
 * being described. Normalizing at the edge means the persistence layer has
 * one code path, and adding a source is a matter of writing a translator
 * rather than another set of SQL writes that can quietly disagree with the
 * existing ones about what a price means.
 */

/** One outcome a book is quoting, already mapped to our vocabulary. */
export interface FeedOutcome {
  /** 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no' | 'outright' */
  side: string
  /** What to display — the team name, "Over", and so on. */
  label: string
  /** This side's handicap or total. Null on markets without one. */
  point: number | null
  /** Decimal odds. */
  price: number
  /** Maximum stake, when the book publishes one. */
  limitAmount?: number
  /**
   * Deep link to this selection on the book's own site.
   *
   * Per-book and unreconstructable from anything else we hold, so the
   * adapter that read the price is the only thing able to supply it.
   */
  link?: string
  /** The book's own id for this outcome, for per-selection reads. */
  sid?: string
  /**
   * Money already matched at this price, on an exchange.
   *
   * Absent for a sportsbook, which quotes a price rather than reporting a
   * market. Where it exists it is the weight behind the number.
   */
  tradedVolume?: number
}

/** One bet type at one line, as a single book quotes it. */
export interface FeedMarket {
  /** 'h2h' | 'spreads' | 'totals' | … */
  marketType: string
  /**
   * The market's line. For totals it is the total; for spreads it is the
   * **home** team's handicap, signed. Null for moneylines.
   *
   * Books disagree about the line, and that disagreement is information
   * rather than noise, so each distinct line becomes its own market
   * instead of being flattened onto a single "main" number. Keeping them
   * separate is also what makes de-vigging correct: the two sides of a
   * market are a genuine complementary pair only when they share a line.
   */
  line: number | null
  period?: string
  /**
   * The player this market is about, for props.
   *
   * Part of a market's identity rather than a label on it: two players'
   * props of the same type at the same line are different markets, and the
   * unique index on `markets` carries this column for exactly that reason.
   */
  playerName?: string
  outcomes: FeedOutcome[]
}

/** Everything one book is quoting on one event. */
export interface FeedBook {
  /** The provider's key for the book, matched against `bookmakers`. */
  key: string
  title: string
  /** The book's own timestamp for these prices. */
  lastUpdate: string
  /** When this process successfully received the book's board. */
  checkedAt?: string
  /** A cached response we did not recheck on this pass. */
  fromCache?: boolean
  markets: FeedMarket[]
}

/** One event, with every book quoting it. */
export interface FeedEvent {
  externalId: string
  /** Our sport slug, already resolved by the provider. */
  sportSlug: string
  commenceAt: string
  homeTeam: string
  awayTeam: string
  books: FeedBook[]
}

/**
 * A source of live odds.
 *
 * `fetchEvents` receives the run tracker so a provider can record its own
 * quota headers, request count, and per-league failures. The caller cannot
 * observe those from outside, and losing them is precisely how a feed
 * degrades invisibly.
 */
export interface OddsProvider {
  readonly name: string
  fetchEvents: (tracker: IngestRunTracker) => Promise<FeedEvent[]>
}
