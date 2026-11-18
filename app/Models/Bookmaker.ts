import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Bookmaker — a place that quotes a price on an outcome.
 *
 * Covers both traditional sportsbooks (DraftKings, Pinnacle, …) and
 * prediction markets (Polymarket, Kalshi, …). `kind` keeps the two apart
 * in the UI while their prices are compared in the same grid.
 *
 * ### Why `sharp` and `consensusWeight` matter
 * Books are not interchangeable estimators. Low-margin, high-limit books
 * that welcome winning bettors (Pinnacle, Circa, and the prediction
 * venues, which are pure order books) carry far more information than a
 * recreational book that copies the market and shades toward public
 * money. A flat average across all books is therefore a *worse* estimate
 * of true probability than the sharp price alone.
 *
 * `consensusWeight` is that judgement made explicit and tunable, and
 * `sharp` marks the books the fair-value anchor is drawn from. Both are
 * data rather than code so a book's status can change without a deploy —
 * which it does, when a book tightens or loosens its limits.
 */
export default defineModel({
  name: 'Bookmaker',
  table: 'bookmakers',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    // Our odds feed, at `/api/feed/books`. The books and exchanges we price from. Read-only: the list is reference data every ingest path keys on.
    // Reads only, behind the account's API key (`phq_…`, metered against
    // its plan): the rows are written by ingestion and nothing else.
    useApi: {
      uri: 'books',
      prefix: 'feed',
      routes: ['index', 'show'],
      middleware: ['throttle:240,1', 'apikey:required'],
    },
    // Reference data. `providerKey` must match the feed's own key exactly
    // or the book's prices are silently dropped, and `consensusWeight`
    // encodes the judgement described in the class note above.
    useSeeder: {
      count: 0,
      fixtures: [
        { slug: 'pinnacle', name: 'Pinnacle', kind: 'sportsbook', providerKey: 'pinnacle', accent: 'orange', short: 'PIN', region: 'eu', sharp: true, consensusWeight: 4, active: true, transport: 'json' },
        { slug: 'circa', name: 'Circa Sports', kind: 'sportsbook', providerKey: 'circasports', accent: 'red', short: 'CIR', region: 'us', sharp: true, consensusWeight: 3, active: true, transport: 'json' },
        { slug: 'betonlineag', name: 'BetOnline', kind: 'sportsbook', providerKey: 'betonlineag', accent: 'lime', short: 'BOL', region: 'us', sharp: true, consensusWeight: 2, active: true, transport: 'json' },
        { slug: 'draftkings', name: 'DraftKings', kind: 'sportsbook', providerKey: 'draftkings', accent: 'emerald', short: 'DK', region: 'us', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'fanduel', name: 'FanDuel', kind: 'sportsbook', providerKey: 'fanduel', accent: 'sky', short: 'FD', region: 'us', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'betmgm', name: 'BetMGM', kind: 'sportsbook', providerKey: 'betmgm', accent: 'amber', short: 'MGM', region: 'us', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'caesars', name: 'Caesars', kind: 'sportsbook', providerKey: 'williamhill_us', accent: 'yellow', short: 'CZR', region: 'us', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'espnbet', name: 'ESPN BET', kind: 'sportsbook', providerKey: 'espnbet', accent: 'rose', short: 'ESPN', region: 'us', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'bet365', name: 'bet365', kind: 'sportsbook', providerKey: 'bet365', accent: 'green', short: 'B365', region: 'uk', sharp: false, consensusWeight: 1.5, active: true, transport: 'browser' },
        { slug: 'williamhill', name: 'William Hill', kind: 'sportsbook', providerKey: 'williamhill', accent: 'blue', short: 'WH', region: 'uk', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        { slug: 'unibet', name: 'Unibet', kind: 'sportsbook', providerKey: 'unibet', accent: 'indigo', short: 'UNI', region: 'eu', sharp: false, consensusWeight: 1, active: true, transport: 'json' },
        // Exchanges. Two-sided order books rather than bookmakers: the
        // price is what someone actually matched, and the depth behind it
        // is published, which is why they carry sharp weight.
        { slug: 'betfair', name: 'Betfair Exchange', kind: 'sportsbook', providerKey: 'betfair_ex_uk', accent: 'fuchsia', short: 'BF', region: 'uk', sharp: true, consensusWeight: 3.5, active: true, transport: 'json' },
        { slug: 'smarkets', name: 'Smarkets', kind: 'sportsbook', providerKey: 'smarkets', accent: 'cyan', short: 'SMK', region: 'uk', sharp: true, consensusWeight: 3, active: true, transport: 'json' },
        { slug: 'matchbook', name: 'Matchbook', kind: 'sportsbook', providerKey: 'matchbook', accent: 'purple', short: 'MB', region: 'uk', sharp: true, consensusWeight: 2.5, active: true, transport: 'json' },
        // Order books rather than bookmakers: no margin to remove, and the
        // price is a traded probability, so they anchor fair value well.
        { slug: 'polymarket', name: 'Polymarket', kind: 'prediction', providerKey: 'polymarket', accent: 'violet', short: 'PM', region: 'global', sharp: true, consensusWeight: 3, active: true },
        { slug: 'kalshi', name: 'Kalshi', kind: 'prediction', providerKey: 'kalshi', accent: 'teal', short: 'KAL', region: 'us', sharp: true, consensusWeight: 3, active: true },
      ],
    },
  },

  indexes: [
    { name: 'bookmakers_slug', columns: ['slug'], unique: true },
  ],

  attributes: {
    name: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(100) },
      factory: faker => faker.company.name(),
    },
    slug: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(100) },
      factory: faker => faker.lorem.slug(),
    },
    // 'sportsbook' | 'prediction'
    kind: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'sportsbook',
      validation: { rule: schema.enum(['sportsbook', 'prediction']) },
      factory: faker => faker.helpers.arrayElement(['sportsbook', 'prediction']),
    },
    // crosswind color token used for the book's badge
    accent: {
      type: 'string',
      fillable: true,
      default: 'slate',
      validation: { rule: schema.string().max(40) },
      factory: () => 'slate',
    },
    // short mark for compact column headers, e.g. "DK", "PIN"
    short: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(8) },
      factory: faker => faker.string.alpha({ length: 3, casing: 'upper' }),
    },
    // Key the odds feed knows this book by, for provider→row matching.
    // Explicit because feed keys ('betmgm') differ from our slugs.
    providerKey: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: faker => faker.lorem.slug(),
    },
    // Regulatory region the quotes come from: 'us' | 'us2' | 'uk' | 'eu' | 'au'
    region: {
      type: 'string',
      fillable: true,
      default: 'us',
      validation: { rule: schema.string().max(10) },
      factory: () => 'us',
    },
    // Low margin, high limits, tolerates winners — a price worth anchoring
    // fair value to. See the class note.
    sharp: {
      type: 'boolean',
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
    // Relative trust in this book's price when blending a consensus.
    // 1.0 is the default; sharp books sit well above it.
    consensusWeight: {
      type: 'number',
      precision: 8,
      scale: 4,
      fillable: true,
      default: 1,
      validation: { rule: schema.float().min(0).max(10) },
      factory: () => 1,
    },
    active: {
      type: 'boolean',
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },
    url: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(200) },
      factory: () => '',
    },
    lastSeenAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
    /**
     * How our own adapter reaches this book.
     *
     * '' means we have no native adapter and the book only ever arrives
     * via a paid aggregator. The distinction is operational: a `browser`
     * book costs a page load per poll and cannot be cadenced like a `json`
     * one, and knowing which is which is what stops the engine budgeting
     * them the same.
     */
    transport: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.enum(['', 'json', 'html', 'browser', 'websocket']) },
      factory: () => '',
    },
    /**
     * When this book last returned a usable price.
     *
     * Distinct from `lastSeenAt`, which moves whenever the book is
     * mentioned. This only moves on success, so it is the field that can
     * answer "has DraftKings been quiet for an hour" — the question a
     * silently-broken adapter otherwise never prompts anyone to ask.
     */
    lastSuccessAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
    /**
     * Consecutive failed passes, reset by any success.
     *
     * A book has a bad minute constantly; a book has a bad *afternoon*
     * rarely, and only the second is worth waking someone for. Counting
     * the streak rather than the failures is what separates them.
     */
    failureStreak: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  hasMany: ['Odd', 'OddsSnapshot', 'ClosingLine'],
} as const)
