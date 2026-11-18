import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * DecisionEvidence — one measured fact that moved a decision.
 *
 * This is the audit trail behind "AI-driven": each row is a number our
 * own pipeline computed, the query window it came from, and how far it
 * pushed fair value. Read together they reconstruct a decision's
 * arithmetic without re-running anything, which is the difference
 * between a model that can be checked and one that has to be trusted.
 *
 * `kind` names the signal family:
 *   smart_money    — accuracy-weighted flow from traders with a track record
 *   trader_accuracy— the resolved win rate behind that flow
 *   flow_imbalance — notional bought per side over the window
 *   price_trend    — where the venue price has moved recently
 *   liquidity      — depth available, which caps size rather than direction
 *   cross_venue    — the other venue's price on the same question
 */
export default defineModel({
  name: 'DecisionEvidence',
  table: 'decision_evidence',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'decision', columns: ['tradeDecisionId'] },
  ],

  attributes: {
    tradeDecisionId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    kind: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.helpers.arrayElement([
        'smart_money',
        'trader_accuracy',
        'flow_imbalance',
        'price_trend',
        'liquidity',
        'cross_venue',
      ]),
    },
    // One line a human can read without the numbers.
    summary: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => '',
    },
    // The measurement itself, in whatever unit `kind` implies.
    value: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -1, max: 1, fractionDigits: 3 }),
    },
    // How many probability points this signal contributed to fair value.
    // Signed: negative argues against the side that was taken.
    contribution: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      validation: { rule: schema.float() },
      factory: faker => faker.number.float({ min: -0.1, max: 0.1, fractionDigits: 4 }),
    },
    // Rows the measurement was computed over. A signal standing on three
    // fills is not the same claim as one standing on three hundred, and
    // the number is what lets a reader tell them apart.
    sampleSize: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    // Lookback the query used, in hours.
    windowHours: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 24,
    },
  },
} as const)
