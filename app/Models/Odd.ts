import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Odd — one bookmaker's *current* price on one selection.
 *
 * Stored as **decimal odds** (e.g. 2.10) so a sportsbook line and a
 * prediction-market share price live in the same unit and compare
 * directly. The join row between {@link Bookmaker} and {@link Selection}.
 *
 * One row per (selection, bookmaker), enforced by a unique index — the
 * ingest upserts against it. Price *history* is append-only in
 * {@link OddsSnapshot}; this table only ever holds the latest.
 *
 * `impliedProb` is denormalized (1/price) so the board can filter and sort
 * on probability without recomputing across every row on every request.
 * Note it still contains the book's margin — the de-vigged number lives on
 * {@link FairPrice}, and the two must not be confused: every honest edge
 * calculation compares a price against the *fair* probability, never
 * against this one.
 */
export default defineModel({
  name: 'Odd',
  table: 'odds',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    // Our odds feed, at `/api/feed/odds`. Each book's current price per selection. Filter with `?selection_id=` or `?bookmaker_id=`.
    // Reads only, behind the account's API key (`phq_…`, metered against
    // its plan): the rows are written by ingestion and nothing else.
    useApi: {
      uri: 'odds',
      prefix: 'feed',
      routes: ['index', 'show'],
      middleware: ['throttle:240,1', 'apikey:required'],
    },
    useSeeder: { count: 0 },
  },

  indexes: [
    // One current price per book per selection. The ingest upsert key.
    { name: 'odds_selection_bookmaker', columns: ['selection_id', 'bookmaker_id'], unique: true },
    { name: 'odds_bookmaker', columns: ['bookmaker_id'] },
  ],

  attributes: {
    // Decimal odds. 2.00 = even money; higher = bigger payout per unit.
    price: {
      type: 'number',
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(1.01) },
      factory: faker => faker.number.float({ min: 1.2, max: 9, fractionDigits: 2 }),
    },
    // American/moneyline form of `price`, precomputed for display.
    american: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.int({ min: -400, max: 400 }),
    },
    // 1/price. Includes the book's margin — see the class note.
    impliedProb: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.1, max: 0.9, fractionDigits: 4 }),
    },
    // The line this price is attached to, copied from the selection so a
    // price is self-describing without a join. Books move the line and the
    // price independently, and a stale join would misattribute both.
    point: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => null,
    },
    // Maximum accepted stake, when the book publishes it. Liquidity is a
    // real signal: a sharp price with a $50 limit is not the same market
    // as the same price with a $50k limit.
    limitAmount: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    // Whether the book is currently taking action on this selection.
    available: {
      type: 'boolean',
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },
    // When the provider says this price was last set — not when we wrote
    // it. Books report their own timestamps and they lag polling.
    observedAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => new Date().toISOString(),
    },
    /**
     * Deep link to this exact selection on the book's own site.
     *
     * The difference between "DraftKings has 2.10" and a click that lands
     * on the bet slip already filled in. Worth a column rather than a
     * reconstruction, because the URL shape is per-book and changes
     * without notice — the adapter that read the price is the only thing
     * that knows how to address it.
     */
    link: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
    /**
     * The book's own id for this selection.
     *
     * Its "selection id", "outcome id", or whatever it calls the thing.
     * Placing a bet programmatically needs it, and so does asking the book
     * about one specific outcome rather than re-reading a whole event.
     */
    sid: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: () => '',
    },
    /**
     * Money already matched at this price, on an exchange.
     *
     * Zero for a traditional sportsbook, which quotes a price rather than
     * reporting a market. On an exchange it is the weight behind the
     * number: a price with £4 matched is a quote, the same price with
     * £40,000 matched is a consensus, and averaging the two as equals is
     * how a thin market gets to outvote a deep one.
     */
    tradedVolume: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
  },

  belongsTo: ['Selection', 'Bookmaker'],
} as const)
