import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * ExchangeAccount — one user's trading connection to a venue.
 *
 * The venue credentials never live here in the clear: `credentials` holds
 * an AES-GCM envelope produced by `app/Services/trading/credentials.ts`,
 * which is the only place that decrypts it. Nothing that renders an
 * account (API, dashboard, logs) reads that column — `maskedIdentifier`
 * exists so a user can tell two connected accounts apart without it.
 *
 * `status` gates execution: an account is 'pending' until a balance read
 * proves the credentials work, 'active' once it does, and 'revoked' when
 * the venue rejects them. The executor only places orders on 'active'.
 */
export default defineModel({
  name: 'ExchangeAccount',
  table: 'exchange_accounts',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  // One account per user per venue — reconnecting updates in place rather
  // than leaving an orphaned credential envelope behind.
  indexes: [
    { name: 'user_venue', columns: ['userId', 'venue'], unique: true },
  ],

  attributes: {
    userId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    // 'kalshi' | 'polymarket'
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['kalshi', 'polymarket']),
    },
    // User-chosen label, so several connections read as distinct.
    label: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(60) },
      factory: () => 'Primary',
    },
    // Encrypted credential envelope. Never fillable from a request body —
    // it is written only by ConnectExchangeAccount after encryption.
    credentials: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string() },
      factory: () => '',
    },
    // Last 4 of the venue key / wallet, for display. Safe to expose.
    maskedIdentifier: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(24) },
      factory: faker => `…${faker.string.alphanumeric(4)}`,
    },
    // 'pending' | 'active' | 'revoked'
    status: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'pending',
    },
    // Venue-reported settled balance in USD, refreshed on each sync.
    balance: {
      type: 'number',
      fillable: false,
      validation: { rule: schema.float().min(0) },
      factory: faker => faker.number.int({ min: 0, max: 25_000 }),
    },
    // Why the venue last rejected us, '' when healthy. Surfaced to the
    // user because a silently dead connection looks identical to a
    // strategy that simply found nothing to trade.
    lastError: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
    lastSyncedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    termsAcceptedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    riskAcceptedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    ageConfirmedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
    jurisdiction: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(8) },
      factory: () => 'US',
    },
  },

  hasMany: ['ExchangeOrder'],
} as const)
