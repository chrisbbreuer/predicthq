import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * ExchangeOrder — an order we sent to a venue, and what became of it.
 *
 * Written as 'pending' with its `clientOrderId` BEFORE the network call,
 * so a request that dies mid-flight leaves a record instead of a silent
 * position. That id is the venue's idempotency key too: a retry of the
 * same decision reuses it and the venue collapses the duplicate rather
 * than filling twice.
 *
 * Fills are reconciled by the sync pass rather than trusted from the
 * placement response — a resting limit order is not filled just because
 * the venue accepted it.
 */
export default defineModel({
  name: 'ExchangeOrder',
  table: 'exchange_orders',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    // One decision may create exactly one order. The unique constraint is
    // the database half of placement idempotency: concurrent workers can
    // race all the way to the insert and only one receives the claim.
    { name: 'trade_decision_id', columns: ['tradeDecisionId'], unique: true },
    { name: 'account', columns: ['exchangeAccountId'] },
    { name: 'status', columns: ['status'] },
    // The idempotency key. Unique so a retry cannot create a second row
    // for the same attempt even if the first response was never seen.
    { name: 'client_order_id', columns: ['clientOrderId'], unique: true },
  ],

  attributes: {
    tradeDecisionId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    exchangeAccountId: {
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
    // Our id, sent to the venue as its idempotency key.
    clientOrderId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(80) },
      factory: faker => faker.string.uuid(),
    },
    // The venue's id once it accepts, '' while pending or failed.
    externalOrderId: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(120) },
      factory: () => '',
    },
    // Venue market identifier (Kalshi ticker / Polymarket token id).
    marketExternalId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.alphanumeric(24),
    },
    side: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(60) },
      factory: faker => faker.helpers.arrayElement(['yes', 'no']),
    },
    limitPrice: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: faker => faker.number.float({ min: 0.05, max: 0.95, fractionDigits: 3 }),
    },
    size: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    filledSize: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    avgFillPrice: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'failed'
    status: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'pending',
    },
    // Venue rejection text, '' on success. Kept verbatim: a paraphrased
    // exchange error is worth nothing when reconciling a break.
    error: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },
    placedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    // How much of this order's fill has already been folded into a
    // position, and what it cost. Fills arrive cumulatively — the venue
    // reports a running total and an average, never the increment — so
    // booking the difference needs the last total we booked. Without
    // these, a partial fill that grows across two reconciliation passes
    // is counted twice.
    accruedSize: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    accruedCost: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
  },
} as const)
