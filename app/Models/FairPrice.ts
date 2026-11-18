import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * FairPrice — the de-vigged, consensus view of one {@link Selection}.
 *
 * One row per selection, recomputed after each ingest. This is the table
 * the product's honest numbers come from.
 *
 * ### Why raw implied probability is not enough
 * `1 / decimal odds` is not a probability — it is a probability plus the
 * book's margin. On a two-way market priced 1.91 / 1.91 the implied
 * probabilities sum to 104.7%, and that 4.7% is the book's cut, not
 * information about the game. Any "edge" computed by comparing a price
 * against a raw implied probability is measuring vig, and will show edge
 * on markets that have none.
 *
 * Removing it requires a choice about *where* the margin sits, and the
 * three standard answers disagree most on longshots — exactly where value
 * is claimed most often. So all three are stored rather than one:
 *
 * - `probMultiplicative` — scale every implied probability so they sum to
 *   1. Simple, and assumes the margin is spread proportionally. Known to
 *   under-price favourites and over-price longshots.
 * - `probPower` — solve for the exponent k where Σ pᵢ^k = 1. Handles the
 *   favourite–longshot bias better at the cost of an iterative solve.
 * - `probShin` — Shin's model, which derives the margin from an assumed
 *   share of insider money. Usually the best-calibrated of the three on
 *   liquid markets, and the default this codebase reports.
 *
 * Keeping all three makes the disagreement between them visible, and that
 * disagreement is itself a signal: methods diverging sharply is a marker
 * of a thin or badly-priced market. `probConsensus` is the shipped answer
 * — a weighted blend across books, anchored on the sharp ones.
 */
export default defineModel({
  name: 'FairPrice',
  table: 'fair_prices',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    { name: 'fair_prices_selection', columns: ['selection_id'], unique: true },
    // "Where is the edge right now" — the flagship query.
    { name: 'fair_prices_edge', columns: ['edge_pct'] },
  ],

  attributes: {
    // The shipped fair probability: weighted across books, sharp-anchored.
    // Probabilities keep six places and prices four. The framework's default
    // for a number is DECIMAL(10,2), which rounded every fair probability to a
    // whole percentage point: coarser than the 3-point edges the strategy acts
    // on, and enough to flip which side a thin edge favours.
    probConsensus: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    // Fair probability from the sharp books alone, 0 when none quote it.
    probSharp: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    probMultiplicative: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    probPower: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    probShin: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    // Spread between the highest and lowest de-vig method. High values
    // flag a market the three models disagree about — treat with care.
    methodSpread: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    // Fair decimal odds, 1/probConsensus. Denormalized for display.
    fairPrice: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.float({ min: 1.1, max: 12, fractionDigits: 3 }),
    },
    // Best price anyone currently offers, and who offers it.
    bestPrice: {
      type: 'number',
      precision: 10,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.float({ min: 1.1, max: 12, fractionDigits: 3 }),
    },
    bestBookmakerId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'bookmakers', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    // (bestPrice × probConsensus − 1) × 100 — expected return per unit
    // staked at the best available price, in percent. The honest edge.
    edgePct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -8, max: 8, fractionDigits: 3 }),
    },
    // Growth-optimal stake fraction at that edge, already scaled down by
    // the configured Kelly fraction. Never negative.
    kellyFraction: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // The market's total margin (overround − 1) as a percent, from the
    // book set used. A market-quality readout in its own right.
    overroundPct: {
      type: 'number',
      precision: 10,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: 1, max: 8, fractionDigits: 2 }),
    },
    // How many books this was computed from. One book is not a consensus,
    // and the API surfaces this so thin estimates can be discounted.
    bookCount: {
      type: 'integer',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 8 }),
    },
    sharpBookCount: {
      type: 'integer',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 3 }),
    },
    computedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => new Date().toISOString(),
    },
  },

  belongsTo: ['Selection'],
} as const)
