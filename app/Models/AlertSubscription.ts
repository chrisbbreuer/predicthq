import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * AlertSubscription — a standing request to be told about one kind of
 * thing, by someone in particular.
 *
 * Alerts were system-wide: an arbitrage was written against user zero and
 * pushed onto a public channel, which reaches whoever happens to have the
 * page open. Nobody could ask to be told about NFL edges over four points
 * and nothing else, and nobody was reachable when the page was closed —
 * which is when an alert is worth anything.
 *
 * The filters are deliberately coarse. A subscription that can express
 * anything is a query language nobody debugs; league, venue, and a
 * threshold cover what people actually ask for, and a sharper cut is
 * better served by reading the board.
 */
export default defineModel({
  name: 'AlertSubscription',
  table: 'alert_subscriptions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'user', columns: ['userId'] },
    // The lookup every fired alert does: everyone watching for this kind.
    { name: 'kind_active', columns: ['kind', 'active'] },
  ],

  attributes: {
    userId: {
      type: 'bigint',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    // 'arbitrage' | 'edge'
    kind: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(30) },
      factory: () => 'arbitrage',
    },
    // Comma-separated league or category allowlist; '' means every one.
    leagues: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(300) },
      factory: () => '',
    },
    // 'kalshi' | 'polymarket' | 'both'. Ignored by kinds without a venue.
    venue: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(20) },
      factory: () => 'both',
    },
    // The floor, in percentage points, below which this is not worth
    // waking someone for. Its meaning depends on the kind: arbitrage
    // profit for one, modelled edge for the other.
    minValue: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float().min(0).max(100) },
      factory: () => 1,
    },
    // Comma-separated delivery channels: 'database', 'email'.
    channels: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => 'database',
    },
    active: {
      type: 'boolean',
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },
    // When this subscription last caused a delivery. Read to keep a
    // busy night from becoming a hundred emails.
    lastSentAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },
} as const)
