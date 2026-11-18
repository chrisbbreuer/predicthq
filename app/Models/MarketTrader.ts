import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * MarketTrader — a participant identity on a prediction venue.
 *
 * Polymarket trades are attributable to a proxy wallet (plus a public
 * pseudonym), so real per-trader patterns can be read there. Kalshi's
 * public feed is anonymous — its trades carry no trader and never link
 * here. The aggregate columns are recomputed by the analytics pass
 * (app/Services/prediction-markets/analytics.ts) after each ingest:
 * they answer "does this account keep buying the side that ends up
 * winning, and how big does it bet?"
 */
export default defineModel({
  name: 'MarketTrader',
  table: 'market_traders',
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
    // 'polymarket' (Kalshi's public tape is anonymous)
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'polymarket',
    },
    // Proxy wallet address (0x…)
    externalId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => `0x${faker.string.hexadecimal({ length: 40, prefix: '' })}`,
    },
    // Venue pseudonym / display name, if any.
    alias: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: faker => faker.internet.username(),
    },
    tradeCount: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 500 }),
    },
    // Sum of trade notionals (USD).
    totalNotional: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 1_000_000 }),
    },
    avgTradeSize: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 10_000 }),
    },
    maxTradeSize: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 100_000 }),
    },
    // Trades on markets that have since settled.
    resolvedTradeCount: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 200 }),
    },
    // …of those, trades that were on the winning side.
    winningTradeCount: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 200 }),
    },
    // winningTradeCount / resolvedTradeCount, 0..1.
    winRate: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0, max: 1, fractionDigits: 3 }),
    },
    // Composite smart-money score, 0..100 (see analytics.ts).
    smartScore: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(100) },
      factory: faker => faker.number.int({ min: 0, max: 100 }),
    },
    // Large-notional participant flag.
    isWhale: {
      type: 'boolean',
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: faker => faker.datatype.boolean(),
    },
  },

  hasMany: ['MarketTrade'],
} as const)
