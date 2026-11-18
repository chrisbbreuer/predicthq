import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * TradeDecision — one proposal to take a side on one market.
 *
 * A decision is never the model's opinion on its own. `fairValue` comes
 * from our own ingested tape (see app/Services/trading/evidence.ts) and
 * the reasons that produced it are persisted as DecisionEvidence rows
 * before the decision is written. A decision with no evidence is not a
 * decision the engine is allowed to make — that invariant is what makes
 * every automated position explainable after the fact.
 *
 * The AI's contribution is `rationale` and the accept/decline judgement
 * within those bounds; it cannot invent a market, a side, or an edge that
 * the evidence did not already support.
 */
export default defineModel({
  name: 'TradeDecision',
  table: 'trade_decisions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'strategy', columns: ['tradingStrategyId'] },
    { name: 'market', columns: ['predictionMarketId'] },
    { name: 'status', columns: ['status'] },
    // A strategy revisits a market for as long as the market exists, so
    // this cannot be unique. It was, and one decision per pair meant a
    // market a strategy had traded once — or failed to trade once, on a
    // transient venue error — could never be considered again.
    //
    // What must not happen is two live proposals at the same time, and
    // that is enforced where it can be reasoned about: the write path
    // updates the standing decision in place and only starts a new one
    // once the previous one has no working order behind it.
    { name: 'strategy_market', columns: ['tradingStrategyId', 'predictionMarketId'] },
  ],

  attributes: {
    tradingStrategyId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    predictionMarketId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    // Side to buy: 'yes' | 'no' | an outcome label.
    side: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(60) },
      factory: faker => faker.helpers.arrayElement(['yes', 'no']),
    },
    // Venue price at decision time, 0..1.
    marketPrice: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 3 }),
    },
    // What our data says the side is worth, 0..1.
    fairValue: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 3 }),
    },
    // fairValue − marketPrice, in probability points.
    edge: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -0.2, max: 0.2, fractionDigits: 3 }),
    },
    // 0..1. Drives sizing and the minConfidence gate.
    confidence: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.3, max: 0.95, fractionDigits: 2 }),
    },
    // Limit price we are willing to pay, 0..1.
    limitPrice: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 3 }),
    },
    // Contracts to buy.
    size: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    // size × limitPrice, in USD. Denormalized for the exposure queries
    // the risk checks run on every pass.
    notional: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 5, max: 250 }),
    },
    // Plain-language reason, shown to the user next to the evidence.
    rationale: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => '',
    },
    // Which model arbitrated, or 'rules' when the deterministic scorer
    // decided alone (no AI configured, or the call failed).
    decidedBy: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(60) },
      factory: () => 'rules',
    },
    // 'proposed' | 'approved' | 'rejected' | 'executed' | 'skipped' | 'failed'
    status: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'proposed',
    },
    // Why a decision was skipped or rejected, '' otherwise.
    statusReason: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
  },

  hasMany: ['DecisionEvidence', 'ExchangeOrder'],
} as const)
