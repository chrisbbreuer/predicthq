import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * MarketEvent — something with an uncertain outcome that books price up.
 *
 * A game (Lakers vs Celtics), a match (1X2), or a prediction-market
 * question (BTC above $150k?). Named `MarketEvent` rather than `Event` to
 * avoid colliding with the framework event system.
 *
 * An event owns no prices directly. It owns {@link Market} rows — one per
 * bet type and line (moneyline, spread −4.5, total 220.5) — and those own
 * the selections books quote. That indirection is what lets us carry
 * spreads, totals, and props in the same shape as a moneyline.
 *
 * ### Time
 * `commenceAt` is a real UTC ISO timestamp, not a display string. Ordering,
 * "starts within the hour" filters, and the closing-line capture that CLV
 * depends on all key off it. Anything human-readable is formatted at the
 * render layer from this value.
 *
 * ### Identity
 * Events are not keyed by title — feeds spell titles differently and
 * retitle them mid-week. Provider identity lives in {@link EventSource},
 * one row per (provider, external id), so the same game arriving from
 * ESPN and The Odds API resolves to a single event.
 */
export default defineModel({
  name: 'MarketEvent',
  table: 'market_events',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    // Our odds feed, at `/api/feed/events`. Every game we price. Filter with `?sport_id=` or `?status=`, sort with `?sort=commence_at`.
    // Reads only, for signed-in callers and API tokens: the rows are
    // written by ingestion and nothing else.
    useApi: {
      uri: 'events',
      prefix: 'feed',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
    useSeeder: { count: 0 },
  },

  indexes: [
    // The board query: upcoming events for a league, soonest first.
    { name: 'market_events_sport_commence', columns: ['sport_id', 'commence_at'] },
    // The scheduler's "what needs closing lines / grading" sweep.
    { name: 'market_events_status_commence', columns: ['status', 'commence_at'] },
  ],

  attributes: {
    title: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(200) },
      factory: faker => `${faker.location.city()} vs ${faker.location.city()}`,
    },
    // Broad facet, denormalized from the sport for cheap filtering.
    category: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(60) },
      factory: faker => faker.helpers.arrayElement(['Basketball', 'Soccer', 'Football', 'Politics', 'Crypto']),
    },
    // League label, denormalized from the sport for the same reason.
    league: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(60) },
      factory: faker => faker.helpers.arrayElement(['NBA', 'NFL', 'Premier League', 'US Politics']),
    },
    // UTC ISO-8601 kickoff. The ordering and cutoff key for the whole app.
    commenceAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.date.soon({ days: 7 }).toISOString(),
    },
    // 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled'
    status: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'scheduled',
      validation: { rule: schema.enum(['scheduled', 'live', 'final', 'postponed', 'cancelled']) },
      factory: faker => faker.helpers.arrayElement(['scheduled', 'live', 'final']),
    },
    // Home/away are two references to the same table, which `belongsTo`
    // cannot express (it derives one FK per model name), so they are
    // declared as explicit foreign-key columns instead.
    homeSportsTeamId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'sports_teams', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    awaySportsTeamId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'sports_teams', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    venue: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(160) },
      factory: () => '',
    },
    broadcast: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: () => '',
    },
    // Live clock/period text straight from the scoreboard ("7:32 - 2nd").
    statusDetail: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: () => '',
    },
    // Last time any provider confirmed this event still exists. Events not
    // seen for a long stretch are stale rather than deleted — a feed
    // dropping a game is usually a feed problem, not a cancelled game.
    lastSeenAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => new Date().toISOString(),
    },
    // Set once the closing-line snapshot has been frozen for this event,
    // so the capture pass is idempotent.
    closingCapturedAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },

  belongsTo: ['Sport'],
  hasMany: ['Market', 'EventSource'],
  hasOne: ['EventResult'],
} as const)
