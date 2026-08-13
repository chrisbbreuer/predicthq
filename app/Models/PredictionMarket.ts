import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * PredictionMarket — a single binary/categorical market on a prediction
 * venue (Kalshi ticker or Polymarket condition).
 *
 * Distinct from `MarketEvent`: this tracks the venue-native market with
 * its settlement result so trades can be scored as winners/losers once
 * the market resolves. `externalId` is the Kalshi ticker or Polymarket
 * conditionId; (`venue`, `externalId`) is the natural key.
 */
export default defineModel({
  name: 'PredictionMarket',
  table: 'prediction_markets',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  // Natural key — the ingest upserts rely on this for dedupe.
  indexes: [
    { name: 'venue_external_id', columns: ['venue', 'externalId'], unique: true },
  ],

  attributes: {
    // 'kalshi' | 'polymarket'
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    // Kalshi ticker (e.g. "KXBTC-26DEC31-B150000") or Polymarket conditionId (0x…)
    externalId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.alphanumeric(24),
    },
    question: {
      type: 'string',
      fillable: true,
      // Kalshi multi-leg markets serialize every leg into the title. These
      // regularly exceed a conventional headline-sized VARCHAR.
      validation: { rule: schema.string().min(1).max(2048) },
      factory: faker => `Will ${faker.company.name()} win?`,
    },
    /**
     * Which outcome this market's YES represents, in the venue's own
     * words: 'Reg Time: Watford', 'Guatemala', 'Tie'.
     *
     * Kalshi lists a fixture as one market per outcome, all sharing a
     * question, so without this the rows are indistinguishable and any
     * signal about one side cannot tell which side it is looking at. The
     * ticker abbreviates it, but by prefix for clubs and by FIFA code for
     * nations, so the ticker alone resolves only some of them.
     */
    outcomeLabel: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(2048) },
      factory: () => '',
    },
    category: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(60) },
      factory: faker => faker.helpers.arrayElement(['Politics', 'Crypto', 'Sports', 'Economics', 'Science']),
    },
    // 'open' | 'closed' | 'settled'
    status: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['open', 'closed', 'settled']),
    },
    // Winning side once settled ('yes' | 'no' | outcome label), '' before.
    result: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => '',
    },
    // Venue-reported lifetime volume in USD.
    volume: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 5_000_000 }),
    },
    liquidity: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 500_000 }),
    },
    // Last traded probability for the yes side, 0..1.
    lastPrice: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.01, max: 0.99, fractionDigits: 2 }),
    },
    // ISO timestamp the market closes/expires.
    endsAt: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.future().toISOString(),
    },
  },

  hasMany: ['MarketTrade'],
} as const)
