import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * OddsSnapshot — a point-in-time price for one bookmaker on one selection.
 *
 * Append-only. Written by the ingestion job whenever a price *changes*, so
 * the table is a change log rather than a poll log: at one row per minute
 * per quote it would reach billions of rows a season and say nothing a
 * change log doesn't.
 *
 * This is the substrate for line movement — open → current, velocity,
 * steam detection, reverse line movement — and for the closing line that
 * CLV is measured against.
 *
 * The `(selection, bookmaker, captured_at)` index is unique so a retried
 * or overlapping ingest pass cannot double-write the same observation and
 * fake a movement that never happened.
 */
export default defineModel({
  name: 'OddsSnapshot',
  table: 'odds_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    // Our odds feed, at `/api/feed/history`. Every price change, append-only. Filter with `?selection_id=` and `?bookmaker_id=`, newest first with `?sort=-captured_at`.
    // Reads only, behind the account's API key (`phq_…`, metered against
    // its plan): the rows are written by ingestion and nothing else.
    useApi: {
      uri: 'history',
      prefix: 'feed',
      routes: ['index', 'show'],
      middleware: ['throttle:240,1', 'apikey:required'],
    },
    useSeeder: { count: 0 },
  },

  indexes: [
    // Idempotency: one observation per quote per instant.
    {
      name: 'odds_snapshots_selection_bookmaker_captured',
      columns: ['selection_id', 'bookmaker_id', 'captured_at'],
      unique: true,
    },
    // The history scan: newest-first for one quote.
    { name: 'odds_snapshots_quote_time', columns: ['selection_id', 'bookmaker_id', 'captured_at'] },
    // The movement feed: everything that moved recently, across books.
    { name: 'odds_snapshots_captured', columns: ['captured_at'] },
  ],

  attributes: {
    price: {
      type: 'number',
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(1.01) },
      factory: faker => faker.number.float({ min: 1.2, max: 9, fractionDigits: 2 }),
    },
    impliedProb: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.1, max: 0.9, fractionDigits: 4 }),
    },
    // The line in force when this price was observed. Without it a spread
    // history is unreadable: a price moving 1.91 → 1.95 means one thing at
    // a steady −4.5 and something else entirely if the line moved to −5.
    point: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => null,
    },
    // UTC ISO timestamp of when this price was observed.
    capturedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => new Date().toISOString(),
    },
    // First price we ever saw from this book on this selection.
    isOpening: {
      type: 'boolean',
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },

  belongsTo: ['Selection', 'Bookmaker'],
} as const)
