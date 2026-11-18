import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * BetSuggestion — a single or parlay PredictHQ proposes, waiting on the user.
 *
 * Shown on the bets page. Approving records it as a paper bet; betting it for
 * real is the user's own action on Kalshi, linked from the card. Suggestions
 * expire when their first game starts, or within minutes for a live leg,
 * because the price they were built on no longer holds. See
 * `app/Services/trading/suggestions.ts`.
 */
export default defineModel({
  name: 'BetSuggestion',
  table: 'bet_suggestions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: ['User'],

  indexes: [
    { name: 'bet_suggestions_user_status', columns: ['user_id', 'status'] },
    { name: 'bet_suggestions_signature', columns: ['user_id', 'signature'] },
  ],

  attributes: {
    // 'single' | 'parlay'
    kind: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.enum(['single', 'parlay']) },
      factory: () => 'single',
    },
    // JSON: the legs, each with ticker, side, price, fair, label, live, startsAt.
    legs: {
      type: 'text',
      required: true,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => '[]',
    },
    // The legs' tickers and sides, so the same bet is not suggested twice a day.
    signature: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => '',
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
    // Cost per $1 of payout: one leg's price, or the legs' prices multiplied.
    price: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.5,
    },
    // Expected return per dollar after the fee, if the book's line is right.
    ev: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => 0,
    },
    rationale: {
      type: 'text',
      fillable: true,
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },
    // 'pending' | 'approved' | 'dismissed' | 'expired'
    status: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'pending',
      validation: { rule: schema.enum(['pending', 'approved', 'dismissed', 'expired']) },
      factory: () => 'pending',
    },
    expiresAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.soon().toISOString(),
    },
    decidedAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
    // What approving produced, e.g. "paper single" or "paper parlay #4".
    outcome: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(255) },
      factory: () => '',
    },
  },
} as const)
