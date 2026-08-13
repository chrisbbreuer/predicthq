import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Market — one bet type, at one line, on one {@link MarketEvent}.
 *
 * "Moneyline", "Spread −4.5", "Total 220.5", "Both teams to score". This
 * is the level books actually quote at, and the level arbitrage and hold
 * are meaningful at: only the selections *within a single market* are
 * mutually exclusive, so summing implied probabilities across markets is
 * meaningless.
 *
 * Splitting this out from the event is what makes non-moneyline coverage
 * possible. Previously selections hung directly off the event with no bet
 * type or line, so a spread and a total on the same game were
 * indistinguishable rows and could not both be stored.
 *
 * `line` is the handicap or total the market is struck at (−4.5, 220.5)
 * and is null for markets that have no line, like a moneyline. It is part
 * of the natural key because a book quoting the same game at 220.5 and at
 * 221 is offering two different markets.
 */
export default defineModel({
  name: 'Market',
  table: 'markets',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    // Natural key — the ingest upsert dedupes on this.
    //
    // Keyed on `line_key` rather than `line` because SQLite (and the SQL
    // standard) treats NULLs as distinct in a unique index: with `line`
    // nullable, every moneyline row would be unique against every other
    // moneyline row and the upsert would insert a duplicate market on
    // every single pass. `line_key` is the same value as a string, with
    // '' standing in for "no line", so the constraint actually binds.
    // `player_name` is part of the key, not a detail hanging off it.
    // Without it, two players' props of the same type at the same line —
    // "over 25.5 points" for either of two starters — collide on this
    // index, and the resolver hands back whichever market it created
    // first. Both players' prices then land on one market and the board
    // shows one of them quoted twice. It is the same class of failure as
    // matching selections by label, and it fails just as silently, so the
    // constraint carries the player rather than trusting callers to.
    //
    // '' for every market that is not a prop, so the constraint binds
    // exactly as it did before for those.
    {
      name: 'markets_event_type_line_period',
      columns: ['market_event_id', 'market_type', 'line_key', 'period', 'player_name'],
      unique: true,
    },
    // Keep a dedicated leading index for the foreign key. MySQL may otherwise
    // use the natural-key index above to enforce it and then refuse an index
    // replacement while the constraint still depends on that index.
    { name: 'markets_market_event_id', columns: ['market_event_id'] },
    { name: 'markets_type', columns: ['market_type'] },
  ],

  attributes: {
    // 'h2h' | 'spreads' | 'totals' | 'btts' | 'draw_no_bet' | 'outrights' | 'player_prop'
    marketType: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'h2h',
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.helpers.arrayElement(['h2h', 'spreads', 'totals']),
    },
    // Human label for the market: "Moneyline", "Spread", "Total Points".
    label: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(80) },
      factory: () => 'Moneyline',
    },
    // Handicap or total. Null for markets without one (moneyline, BTTS).
    line: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.float() },
      factory: () => null,
    },
    // NULL-safe stringification of `line` for the unique index above:
    // '' when there is no line, else the number as written. Derived, never
    // authored — `Market.lineKey()` in the ingest layer is the only writer.
    lineKey: {
      type: 'string',
      required: true,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(20) },
      factory: () => '',
    },
    // Which slice of the game: 'full_game' | '1h' | '2h' | 'q1' | 'p1' | …
    period: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'full_game',
      validation: { rule: schema.string().min(1).max(20) },
      factory: () => 'full_game',
    },
    // For player props: whose line this is. Empty for team markets.
    playerName: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(120) },
      factory: () => '',
    },
    // Whether the selections are mutually exclusive AND exhaustive. Only
    // complete markets get a meaningful hold / arbitrage reading, because
    // the maths assumes the outcomes partition the probability space.
    complete: {
      type: 'boolean',
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },
    // 'open' | 'suspended' | 'settled'
    status: {
      type: 'string',
      required: true,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'suspended', 'settled']) },
      factory: () => 'open',
    },
    // Display order within an event.
    position: {
      type: 'number',
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  belongsTo: ['MarketEvent'],
  hasMany: ['Selection'],
} as const)
