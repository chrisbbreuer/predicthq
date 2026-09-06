import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * VenueOrder — what the venue says is still resting on the book.
 *
 * The same argument as `VenuePosition`, one step earlier in the trade.
 * `ExchangeOrder` records the orders we sent and reconciles each one
 * against its venue id; an order the user placed in Kalshi's own app has
 * no row there and never will, yet it is capital committed right now and
 * belongs on a page about live action.
 *
 * A snapshot, replaced on every sync, and read-only to the rest of the
 * application: reconciliation, fills, and position accrual all continue
 * to work from `ExchangeOrder`, because those must follow orders we are
 * accountable for rather than everything the account happens to be doing.
 */
export default defineModel({
  name: 'VenueOrder',
  table: 'venue_orders',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    // The venue's own order id, scoped to the account that holds it.
    // Unique for the same reason as `VenuePosition`: the snapshot is
    // replaced per pass, so a second row for one order is a bug, and one
    // resting order shown twice reads as twice the committed capital.
    { name: 'account_external_id', columns: ['exchangeAccountId', 'externalOrderId'], unique: true },
    { name: 'market', columns: ['predictionMarketId'] },
  ],

  attributes: {
    exchangeAccountId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    predictionMarketId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    externalOrderId: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.uuid(),
    },
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
      factory: () => 0,
    },
    // What the order was for, and what is left of it. The difference is
    // the part that has already filled, which is why both are kept: a
    // half-filled resting order commits only its remainder.
    size: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    remainingSize: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    placedAt: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    syncedAt: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
