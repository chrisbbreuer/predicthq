import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * FeatureSnapshot — a frozen feature vector for one {@link Selection} at
 * one moment, plus the outcome once it is known.
 *
 * This is the training set. Everything else in the schema describes the
 * present; this table is the only one that preserves *what was knowable
 * at a point in time*, which is the single requirement for supervised
 * learning on markets.
 *
 * ### Why the features are copied rather than joined
 * Recomputing features later from history would leak the future into
 * them. A model trained on features assembled after the fact learns from
 * information no live caller could have had, scores brilliantly in
 * backtest, and fails in production. Copying the values at capture time
 * makes leakage structurally impossible: nothing here can be recomputed,
 * only read.
 *
 * `label` starts at −1 (unknown) and is filled in by the settlement pass
 * once the event resolves. Rows keep their features whatever happens to
 * the market afterwards, which is what makes `capturedAt` → `label` an
 * honest pair.
 */
export default defineModel({
  name: 'FeatureSnapshot',
  table: 'feature_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  casts: {
    extra: 'json',
  },

  indexes: [
    // One snapshot per selection per capture instant.
    { name: 'feature_snapshots_selection_captured', columns: ['selection_id', 'captured_at'], unique: true },
    // The training export: labelled rows in time order.
    { name: 'feature_snapshots_label_captured', columns: ['label', 'captured_at'] },
  ],

  attributes: {
    capturedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => new Date().toISOString(),
    },
    // Hours between capture and kickoff. Markets behave very differently
    // a week out versus ten minutes out, so this is a feature, not
    // metadata — a model that ignores it will conflate the two regimes.
    hoursToStart: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: 0, max: 168, fractionDigits: 2 }),
    },

    // ---- price state -----------------------------------------------------
    bestPrice: {
      type: 'number',
      precision: 10,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.float({ min: 1.1, max: 12, fractionDigits: 3 }),
    },
    fairProb: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    sharpProb: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 4 }),
    },
    edgePct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -8, max: 8, fractionDigits: 3 }),
    },
    overroundPct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: 1, max: 8, fractionDigits: 2 }),
    },
    bookCount: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 10 }),
    },
    // Dispersion of prices across books. Wide disagreement is both an
    // opportunity and a warning that someone has stale information.
    priceStdDev: {
      type: 'number',
      precision: 10,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },

    // ---- movement --------------------------------------------------------
    openPrice: {
      type: 'number',
      precision: 10,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.float({ min: 1.1, max: 12, fractionDigits: 3 }),
    },
    // Percent move from the opening price to now. Sign carries direction.
    moveFromOpenPct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -20, max: 20, fractionDigits: 3 }),
    },
    // Percent move per hour over the recent window — how fast, not just
    // how far. A slow drift and a sudden lurch mean different things.
    velocityPctPerHour: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: () => 0,
    },
    // Several books moving the same way at once: coordinated money.
    steamScore: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // Line moved *against* the side taking most of the public tickets —
    // classically a footprint of sharp money on the other side.
    reverseLineMove: {
      type: 'boolean',
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
    // How many times direction flipped. A market that cannot settle on a
    // price is uncertain in a way a single net move hides.
    directionChanges: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    // ---- context ---------------------------------------------------------
    // Denormalized so an exported training set stands alone without joins
    // against tables that have since moved on.
    sportSlug: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => 'nba',
    },
    marketType: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => 'h2h',
    },
    side: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(20) },
      factory: () => 'home',
    },
    // Room for features added later without a migration per experiment.
    extra: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },

    // ---- label -----------------------------------------------------------
    // -1 unknown, 0 lost, 1 won, 2 push. Written by the settlement pass.
    label: {
      type: 'number',
      required: true,
      fillable: true,
      default: -1,
      validation: { rule: schema.number().min(-1).max(2) },
      factory: () => -1,
    },
    // De-vigged closing probability for this selection, filled in at
    // settlement. `fairProb` minus this is closing line value — the
    // fastest-converging measure of whether the estimate had real edge.
    closingFairProb: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // (bestPrice / closing best price − 1) × 100. Positive means the price
    // taken beat the close.
    clvPct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: () => 0,
    },
    labelledAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },

  belongsTo: ['Selection'],
} as const)
