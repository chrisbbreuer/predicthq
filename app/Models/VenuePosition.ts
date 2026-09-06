import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * VenuePosition — what the venue says the account holds.
 *
 * `ExchangePosition` is our book: rows that accrued from fills on
 * orders we placed, against a strategy, with a cost basis we watched
 * being paid. It is the right basis for performance and for every risk
 * limit, and it is silent about everything else on the account.
 *
 * A user who has traded Kalshi by hand for a year holds positions this
 * application never opened, and a portfolio page that showed only our
 * own book would tell them they own nothing. So this table mirrors the
 * venue's answer to "what do I hold", replaced wholesale on every sync.
 *
 * It is a snapshot, not a ledger: no cost history, no settlement, no
 * profit. Nothing derives a risk limit from it, because a mirror of an
 * external system is exactly the wrong thing to let authorize an order.
 * It exists to be read.
 */
export default defineModel({
  name: 'VenuePosition',
  table: 'venue_positions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    // One row per account, market and side. Unique because the sync
    // replaces an account's rows wholesale and a duplicate could only
    // come from two passes interleaving — which would double a holding
    // on the page. The leading column also serves the per-account read
    // and the delete that begins each pass.
    { name: 'account_market_side', columns: ['exchangeAccountId', 'marketExternalId', 'side'], unique: true },
    { name: 'market', columns: ['predictionMarketId'] },
  ],

  attributes: {
    exchangeAccountId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    // Resolved from the venue ticker when we hold metadata for it, and 0
    // when we do not. A position stays visible either way — the question
    // text is a nicety, and holding a page hostage to it would hide the
    // very markets we know least about.
    predictionMarketId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    marketExternalId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.alphanumeric(24),
    },
    side: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(60) },
      factory: faker => faker.helpers.arrayElement(['yes', 'no']),
    },
    // Contracts, always positive. Kalshi signs the number to mean the
    // side; that convention is unpicked in its client, not stored here.
    size: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    avgPrice: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // When the venue last said this. Every pass replaces the account's
    // rows outright, so this can never be older than the last successful
    // sync — it is here to say how fresh a holding on the page is, which
    // the account's own sync stamp cannot answer per row.
    syncedAt: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
