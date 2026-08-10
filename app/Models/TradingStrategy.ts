import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * TradingStrategy — the standing instruction the automation runs under.
 *
 * Every number here is a limit, not a target. The decision engine can
 * only propose trades inside them and the executor re-checks them before
 * an order leaves the process, so a strategy is the one place a user has
 * to look to know the worst case.
 *
 * `autoExecute` is the difference between a research tool and a trading
 * one: off, decisions queue for manual approval; on, the executor places
 * them. It defaults off, and an entitlement check gates turning it on.
 */
export default defineModel({
  name: 'TradingStrategy',
  table: 'trading_strategies',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'user', columns: ['userId'] },
    { name: 'status', columns: ['status'] },
  ],

  attributes: {
    userId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    name: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(80) },
      factory: faker => `${faker.word.adjective()} follow`,
    },
    // 'kalshi' | 'polymarket' | 'both'
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket', 'both']),
    },
    // Comma-separated category allowlist ('' = every category).
    categories: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
    // Total USD this strategy may have at risk across open positions.
    bankroll: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(1) },
      factory: faker => faker.number.int({ min: 500, max: 10_000 }),
    },
    // Hard cap on a single order's notional, in USD.
    maxStake: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(1) },
      factory: faker => faker.number.int({ min: 10, max: 250 }),
    },
    // Minimum modelled edge (our fair value − venue price, in
    // probability points) before a market is even a candidate.
    minEdge: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.04,
    },
    // Minimum decision confidence, 0..1. Anything the engine is less
    // sure of than this is recorded and skipped, never executed.
    minConfidence: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.65,
    },
    maxOpenPositions: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1).max(500) },
      factory: faker => faker.number.int({ min: 3, max: 25 }),
    },
    // Realized loss (USD) from positions settled within a UTC day that
    // halts the strategy. Realized, not deployed and not marked to
    // market: only a position that closed below its cost basis counts.
    dailyLossLimit: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 50, max: 1000 }),
    },
    // All-time realized losses allowed for this run of the strategy.
    // Unlike `bankroll`, which limits concurrent exposure, this is a true
    // campaign loss ceiling. Zero leaves it disabled for legacy strategies.
    cumulativeLossLimit: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    // 'paper' | 'live'
    //
    // Paper runs the identical decision path and books simulated fills
    // against the tape, touching no venue and no money. It is where a
    // strategy earns the right to be armed: the alternative was going
    // from "saved" to "real orders at an exchange" with no record of
    // whether the thing had ever been right.
    //
    // New strategies start here, and the column is read as 'live' when
    // absent so that strategies which predate it keep behaving as their
    // owners set them up.
    mode: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(10) },
      factory: () => 'paper',
    },
    // Place orders automatically, or queue decisions for approval.
    autoExecute: {
      type: 'boolean',
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
    // 'active' | 'paused' | 'halted'
    // 'halted' is set by the executor, not the user: it is what a
    // breached daily loss limit leaves behind, and it survives a restart.
    status: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'paused',
    },
    // Why the strategy halted itself, '' when it did not.
    haltedReason: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
    lastRunAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },

  hasMany: ['TradeDecision'],
} as const)
