import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * PaperParlay — a simulated Kalshi parlay, settled from its legs' results.
 *
 * Kalshi builds a parlay market only when someone requests a quote, so there
 * is no listed market to paper-trade against. This keeps the legs, the price
 * paid (the legs' asks multiplied), and the stake, and settles once every leg
 * has: any losing leg loses the parlay, all winning legs pay stake ÷ price
 * less Kalshi's fee. See `app/Services/trading/paper-parlays.ts`.
 */
export default defineModel({
  name: 'PaperParlay',
  table: 'paper_parlays',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: ['User', 'TradingStrategy'],

  indexes: [
    { name: 'paper_parlays_user_status', columns: ['user_id', 'status'] },
  ],

  attributes: {
    // JSON: [{ ticker, side, price, label }]
    legs: {
      type: 'text',
      required: true,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => '[]',
    },
    stake: {
      type: 'number',
      precision: 10,
      scale: 2,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: () => 1,
    },
    // What the parlay cost per $1 of payout: the legs' prices multiplied.
    price: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.3,
    },
    // 'open' | 'won' | 'lost'
    status: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'won', 'lost']) },
      factory: () => 'open',
    },
    payout: {
      type: 'number',
      precision: 10,
      scale: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    rationale: {
      type: 'text',
      fillable: true,
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },
    placedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    settledAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },
} as const)
