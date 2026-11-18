import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * ExchangePosition — what a strategy actually owns, and what it earned.
 *
 * An order is an intention with a lifetime of minutes; a position is the
 * consequence, and it lasts until the market resolves. Keeping them
 * apart is what lets the risk checks be right: a filled order is not an
 * open position once the market has settled, and counting it as one is
 * how a strategy silently reaches its position cap and stops trading.
 *
 * Rows accrue from reconciled fills rather than from placement, so the
 * cost basis is what the venue actually charged rather than what the
 * decision hoped to pay. Settlement closes the row against the market's
 * result and writes the realized profit or loss, which is the number the
 * daily loss limit and every performance figure are derived from.
 *
 * The strategy owns the row rather than the account: two strategies
 * trading the same market through one venue account are two books, and
 * merging them would make neither one's performance knowable.
 */
export default defineModel({
  name: 'ExchangePosition',
  table: 'exchange_positions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'strategy_status', columns: ['tradingStrategyId', 'status'] },
    { name: 'account', columns: ['exchangeAccountId'] },
    { name: 'market', columns: ['predictionMarketId'] },
    // The lookup accrual does on every reconciled fill.
    { name: 'book', columns: ['tradingStrategyId', 'marketExternalId', 'side', 'status'] },
  ],

  attributes: {
    tradingStrategyId: {
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
    // Contracts held. Every one pays out a dollar if the side is right.
    size: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 500 }),
    },
    // Total USD paid for that size, summed over the fills that built it.
    costBasis: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: () => 0,
    },
    // costBasis / size, stored so a leaderboard need not recompute it.
    avgPrice: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: false,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    // Settlement proceeds minus cost basis. Zero until the market resolves.
    realizedPnl: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float() },
      factory: () => 0,
    },
    // 'open' | 'settled'
    status: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'open',
    },
    // What each contract paid out: 1 when the side was right, 0 when it
    // was not. Stored rather than re-derived so a corrected result later
    // cannot silently rewrite history that has already been reported.
    settlementPrice: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: false,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },
    openedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    settledAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },
} as const)
