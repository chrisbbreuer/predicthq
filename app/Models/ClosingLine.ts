import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * ClosingLine — the final price each book showed before an event started.
 *
 * Frozen once, at kickoff, and never updated. That immutability is the
 * point: the closing line is the market's last and best consensus, and
 * beating it consistently — closing line value — is the strongest known
 * short-horizon evidence that a bettor or model has genuine edge. Win rate
 * over a few hundred bets is mostly noise; CLV converges far faster.
 *
 * Without this table CLV cannot be computed at all, because the price a
 * bet was struck at is only meaningful against the price the market
 * settled on, and the current-price row is overwritten on every tick.
 *
 * `fairProb` stores the de-vigged closing probability, which is the number
 * CLV should actually be measured against — comparing a taken price to a
 * raw closing price silently credits the model with the book's margin.
 */
export default defineModel({
  name: 'ClosingLine',
  table: 'closing_lines',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    // One closing price per book per selection, forever.
    { name: 'closing_lines_selection_bookmaker', columns: ['selection_id', 'bookmaker_id'], unique: true },
  ],

  attributes: {
    price: {
      type: 'number',
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(1.01) },
      factory: faker => faker.number.float({ min: 1.2, max: 9, fractionDigits: 2 }),
    },
    // 1/price — still carries the book's margin.
    impliedProb: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.1, max: 0.9, fractionDigits: 4 }),
    },
    // De-vigged closing probability — what CLV is measured against.
    fairProb: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 0,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.1, max: 0.9, fractionDigits: 4 }),
    },
    // The line in force at close, for spread and total markets.
    point: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => null,
    },
    capturedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: () => new Date().toISOString(),
    },
    // Seconds between the capture and the scheduled start. A line frozen
    // well before kickoff is a weaker "closing" line, and the consumer
    // deserves to know rather than to assume.
    secondsBeforeStart: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.float() },
      factory: faker => faker.number.int({ min: 0, max: 600 }),
    },
  },

  belongsTo: ['Selection', 'Bookmaker'],
} as const)
