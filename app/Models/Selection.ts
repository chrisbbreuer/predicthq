import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Selection — one possible outcome of a {@link Market}.
 *
 * "Lakers", "Draw", "Over", "Yes". Each selection collects one
 * {@link Odd} per bookmaker; the best of those is what the board
 * highlights.
 *
 * Hangs off a market rather than an event, so "Lakers −4.5" and "Lakers
 * moneyline" are distinct rows that can be priced and graded separately.
 *
 * ### Why `side` exists alongside `label`
 * `label` is what we show ("Los Angeles Lakers"); `side` is what we grade
 * against ('home'). Feeds spell labels differently game to game, so
 * grading on the label would be as brittle as the old name matching.
 * `side` is a closed vocabulary the settlement logic can switch on, and
 * `sportsTeamId` links the row to a resolved team when there is one.
 */
export default defineModel({
  name: 'Selection',
  table: 'selections',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    // Our odds feed, at `/api/feed/selections`. One side of one market. Filter with `?market_id=`.
    // Reads only, for signed-in callers and API tokens: the rows are
    // written by ingestion and nothing else.
    useApi: {
      uri: 'selections',
      prefix: 'feed',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
    useSeeder: { count: 0 },
  },

  indexes: [
    // Natural key within a market — the ingest upsert dedupes on this.
    // Keyed on `point_key` rather than `point` for the NULL-distinctness
    // reason documented on {@link Market}: a nullable column in a unique
    // index does not constrain anything.
    { name: 'selections_market_side_point', columns: ['market_id', 'side', 'point_key'], unique: true },
    { name: 'selections_team', columns: ['sports_team_id'] },
  ],

  attributes: {
    label: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.helpers.arrayElement(['Home', 'Draw', 'Away', 'Over', 'Under', 'Yes', 'No']),
    },
    // Closed vocabulary the grader switches on:
    // 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no' | 'outright'
    side: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().min(1).max(20) },
      factory: faker => faker.helpers.arrayElement(['home', 'away', 'draw', 'over', 'under']),
    },
    // This side's own line: −4.5 for the favourite, +4.5 for the dog,
    // 220.5 for both sides of a total. Null on markets without a line.
    // Part of the natural key because alternate lines share a side.
    point: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => null,
    },
    // NULL-safe stringification of `point` for the unique index above.
    pointKey: {
      type: 'string',
      required: true,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(20) },
      factory: () => '',
    },
    // Stable position so a market always renders rows in a known order.
    position: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
    // Resolved team for this side, when the market has one.
    sportsTeamId: {
      type: 'number',
      fillable: true,
      foreignKey: { table: 'sports_teams', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) },
      factory: () => null,
    },
    // Grading result, written once the event settles:
    // -1 = ungraded, 0 = lost, 1 = won, 2 = push (void, stake returned).
    // Starts at −1 rather than null so "not yet graded" is queryable
    // without a NULL check and cannot be confused with a loss.
    outcome: {
      type: 'number',
      required: true,
      fillable: true,
      default: -1,
      validation: { rule: schema.number().min(-1).max(2) },
      factory: () => -1,
    },
    gradedAt: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },

  belongsTo: ['Market'],
  hasMany: ['Odd', 'OddsSnapshot', 'ClosingLine'],
  hasOne: ['FairPrice'],
} as const)
