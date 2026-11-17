import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * MarketTrade — one public fill on a prediction venue.
 *
 * Polymarket fills carry the taker's proxy wallet (`marketTraderId`
 * links to MarketTrader); Kalshi fills are anonymous and keep a NULL
 * trader id. `isWinner` starts unknown (-1) and is scored to 0/1 by the
 * analytics pass once the parent market settles — that column is what
 * the winning-pattern queries pivot on.
 */
export default defineModel({
  name: 'MarketTrade',
  table: 'market_trades',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  // Natural key (dedupe) + the two lookup paths the analytics joins use.
  indexes: [
    { name: 'venue_external_id', columns: ['venue', 'externalId'], unique: true },
    { name: 'market', columns: ['predictionMarketId'] },
    { name: 'trader', columns: ['marketTraderId'] },
  ],

  attributes: {
    predictionMarketId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    // NULL for anonymous (Kalshi) fills.
    marketTraderId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 100 }),
    },
    // 'kalshi' | 'polymarket' (denormalized for venue-scoped queries)
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    // Venue trade id / transaction hash — dedupe key with venue.
    externalId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.uuid(),
    },
    // Side taken: 'yes' | 'no' (or outcome label on categorical markets).
    side: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.helpers.arrayElement(['yes', 'no']),
    },
    // Fill probability price, 0..1.
    price: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.01, max: 0.99, fractionDigits: 2 }),
    },
    // Contracts / shares filled.
    size: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 10_000 }),
    },
    // USD value of the fill (size × price).
    notional: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 100_000 }),
    },
    // -1 unknown (market open), 0 lost, 1 won.
    isWinner: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(-1).max(1) },
      factory: faker => faker.helpers.arrayElement([-1, 0, 1]),
    },
    // ISO timestamp of the fill.
    tradedAt: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
  },

  belongsTo: ['PredictionMarket', 'MarketTrader'],
} as const)
