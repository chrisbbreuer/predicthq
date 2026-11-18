import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * AiInsight — one thing a model said, and everything needed to hold it to
 * account.
 *
 * The AI layer sits *above* the quantitative one and may not invent
 * markets, sides, or fair values of its own — it reasons about candidates
 * the evidence layer produced, and nothing else. That ordering is what
 * keeps "AI-driven" checkable rather than decorative, and it mirrors the
 * constraint already enforced in `app/Services/trading/evidence.ts`.
 *
 * Every row therefore records the inputs (`selectionId`, `featureHash`)
 * next to the output, so any claim can be traced back to the exact numbers
 * that produced it. A summary whose feature hash no longer matches the
 * current state is stale by construction, which is cheaper to detect than
 * to reason about.
 *
 * `statedProb` is stored separately from the model's prose because it is
 * the only part that can be *scored*. Once the event settles, these
 * accumulate into a track record for the model itself — the same
 * calibration treatment the quantitative estimates get in
 * {@link CalibrationBucket}. An LLM's confidence is worth exactly what its
 * measured calibration says it is, and until it is measured it is worth
 * nothing.
 */
export default defineModel({
  name: 'AiInsight',
  table: 'ai_insights',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    // Latest insight for a selection — the read path.
    { name: 'ai_insights_selection_created', columns: ['selection_id', 'created_at'] },
    // Dedupe: don't pay for the same question on unchanged inputs.
    { name: 'ai_insights_feature_hash', columns: ['feature_hash'] },
    { name: 'ai_insights_event', columns: ['market_event_id'] },
  ],

  attributes: {
    // 'candidate_review' | 'market_summary' | 'movement_explainer'
    kind: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'candidate_review',
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => 'candidate_review',
    },
    // Which selection this is about. Null for whole-event commentary.
    selectionId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'selections', column: 'id', onDelete: 'cascade', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    marketEventId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'market_events', column: 'id', onDelete: 'cascade', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    // Hash of the feature vector the model was shown. Identical inputs
    // reuse the stored answer instead of re-billing for it.
    featureHash: {
      type: 'string',
      required: true,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: faker => faker.string.hexadecimal({ length: 16, prefix: '' }),
    },
    // 'back' | 'lay' | 'pass' — the model's stance on the candidate.
    stance: {
      type: 'string',
      fillable: true,
      default: 'pass',
      validation: { rule: schema.enum(['back', 'lay', 'pass']) },
      factory: faker => faker.helpers.arrayElement(['back', 'lay', 'pass']),
    },
    // The model's own probability for the side, 0..1. Scoreable, and
    // scored — see the class note.
    statedProb: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 3 }),
    },
    // Self-reported confidence, 0..1. Treated as an unvalidated claim
    // until its calibration has been measured.
    confidence: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.2, max: 0.9, fractionDigits: 2 }),
    },
    // One-line verdict for the UI.
    summary: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(600) },
      factory: faker => faker.lorem.sentence(),
    },
    // Full reasoning, shown on demand.
    // A paragraph or several: VARCHAR(255) cut every real review short and
    // failed the whole pipeline on the insert.
    rationale: {
      type: 'text',
      fillable: true,
      default: '',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.paragraph(),
    },
    // Risks the model flagged against its own call, newline-separated.
    // Prompted for explicitly: a model asked only to justify a position
    // will justify it, and the caveats are the useful half.
    caveats: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(2000) },
      factory: () => '',
    },
    model: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: () => 'claude-sonnet-5',
    },
    promptTokens: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 200, max: 4000 }),
    },
    completionTokens: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 50, max: 900 }),
    },
    costUsd: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    latencyMs: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 300, max: 12_000 }),
    },
    // Graded after settlement: -1 unknown, 0 wrong, 1 right, 2 push.
    // A 'pass' stance grades as unknown — declining to call something is
    // neither right nor wrong, and scoring it either way would reward
    // silence or punish restraint.
    outcome: {
      type: 'number',
      required: true,
      fillable: true,
      default: -1,
      validation: { rule: schema.number().min(-1).max(2) },
      factory: () => -1,
    },
    // Squared error of `statedProb` against the outcome, once known.
    brierScore: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    gradedAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },
} as const)
