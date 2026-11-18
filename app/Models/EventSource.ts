import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * EventSource — the identity spine: one row per (provider, external id)
 * pointing at the {@link MarketEvent} we decided they refer to.
 *
 * Before this table existed the odds feed matched incoming outcomes to
 * our rows by normalized *label*, globally. Labels like "Home", "Draw",
 * and "Yes" are not unique across events, so prices landed on whichever
 * row happened to claim the name last — and full names from the feed
 * ("Los Angeles Lakers") never matched short seeded labels ("Lakers") at
 * all, so in practice almost nothing matched and the failure was silent.
 *
 * Matching now happens once, here, when an event is first seen. Every
 * later price update joins on `externalId` and cannot drift.
 *
 * `confidence` and `matchedBy` record *how* the link was made, so a fuzzy
 * match can be audited or revisited later; `matchedBy: 'manual'` marks a
 * human override the resolver must not overwrite.
 */
export default defineModel({
  name: 'EventSource',
  table: 'event_sources',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    // The natural key. Ingest upserts depend on this being unique.
    { name: 'event_sources_provider_external', columns: ['provider', 'external_id'], unique: true },
    { name: 'event_sources_event', columns: ['market_event_id'] },
  ],

  attributes: {
    // 'espn' | 'the-odds-api' | 'kalshi' | 'polymarket'
    provider: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.helpers.arrayElement(['espn', 'the-odds-api', 'kalshi', 'polymarket']),
    },
    // The provider's own id for this event.
    externalId: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(160) },
      factory: faker => faker.string.alphanumeric(16),
    },
    // How the link was established: 'external_id' | 'team_pair' | 'fuzzy' | 'manual'
    matchedBy: {
      type: 'string',
      fillable: true,
      default: 'external_id',
      validation: { rule: schema.enum(['external_id', 'team_pair', 'fuzzy', 'manual']) },
      factory: () => 'external_id',
    },
    // 0..1 — how sure the resolver was. Exact id matches are 1.
    confidence: {
      type: 'number',
      precision: 8,
      scale: 6,
      fillable: true,
      default: 1,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 1,
    },
    // The provider's title at match time, kept for auditing a bad link.
    externalTitle: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(240) },
      factory: faker => faker.lorem.sentence(4),
    },
    lastSeenAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => new Date().toISOString(),
    },
    /**
     * The rotation number this book prints against the game.
     *
     * The betting industry's own cross-book identifier, and the one thing
     * a human comparing two screens actually reads. Zero means the
     * provider did not publish one; they are per-book and per-day, which
     * is why it belongs on the source link rather than on the event.
     */
    rotationNumber: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  belongsTo: ['MarketEvent'],
} as const)
