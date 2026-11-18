import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * CalibrationBucket — one probability bin of a reliability curve.
 *
 * Answers the only question that matters about a probabilistic model: when
 * it says 70%, does the thing happen 70% of the time? Accuracy cannot tell
 * you this. A model that says 55% on every NBA favourite is ~65% accurate
 * and badly calibrated, and staking against it loses money on exactly the
 * bets it is most confident about.
 *
 * Rows are recomputed periodically by bucketing settled
 * {@link FeatureSnapshot} rows on predicted probability and comparing the
 * bucket's mean prediction to the observed hit rate. `scope` lets the same
 * curve be cut overall, per league, or per market type — models are often
 * well calibrated in aggregate and badly skewed inside one segment, and
 * only the segmented view shows it.
 *
 * Brier score and log loss are stored alongside because they penalise
 * differently: Brier is bounded and forgiving of confident misses, log
 * loss is unbounded and punishes them severely. Tracking one alone hides
 * a failure mode the other catches.
 */
export default defineModel({
  name: 'CalibrationBucket',
  table: 'calibration_buckets',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    {
      name: 'calibration_buckets_scope_bucket',
      columns: ['scope', 'scope_key', 'bucket_lower'],
      unique: true,
    },
  ],

  attributes: {
    // 'overall' | 'sport' | 'market_type'
    scope: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'overall',
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => 'overall',
    },
    // '' for overall, else the sport slug or market type.
    scopeKey: {
      type: 'string',
      required: true,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(60) },
      factory: () => '',
    },
    // Bin edges, e.g. 0.60 → 0.70.
    bucketLower: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.6,
    },
    bucketUpper: {
      type: 'number',
      precision: 8,
      scale: 6,
      required: true,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.7,
    },
    // Mean predicted probability of the rows that fell in this bin.
    predictedAvg: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.65,
    },
    // How often those predictions actually came in. The whole point:
    // this should track `predictedAvg` closely on a calibrated model.
    observedRate: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.63,
    },
    sampleSize: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 500 }),
    },
    // Mean squared error of the predictions in this bin. Lower is better.
    brierScore: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0.21,
    },
    // Mean negative log likelihood. Punishes confident misses hardest.
    logLoss: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0.62,
    },
    // Mean CLV of the rows in this bin, in percent.
    avgClvPct: {
      type: 'number',
      precision: 12,
      scale: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: () => 0,
    },
    computedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => new Date().toISOString(),
    },
  },
} as const)
