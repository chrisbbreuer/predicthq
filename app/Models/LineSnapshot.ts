import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * LineSnapshot — Kalshi's quote on a game next to the sportsbook line at the
 * same moment.
 *
 * Recorded every five minutes for games starting within three hours, so we
 * can test, going forward, whether the book's line leads Kalshi's price.
 * That can't be replayed from the past: ESPN keeps only the closing line,
 * and by tip-off Kalshi has already caught up to it. See
 * `app/Services/trading/line-snapshots.ts`.
 */
export default defineModel({
  name: 'LineSnapshot',
  table: 'line_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  indexes: [
    { name: 'line_snapshots_ticker_recorded', columns: ['ticker', 'recorded_at'] },
    { name: 'line_snapshots_recorded', columns: ['recorded_at'] },
  ],

  attributes: {
    // The Kalshi market ticker; YES names `side`'s team.
    ticker: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(80) },
      factory: () => 'KXNBAGAME-26NOV18MEMCLE-CLE',
    },
    league: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(20) },
      factory: () => 'nba',
    },
    espnGameId: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(20) },
      factory: () => '401909960',
    },
    // 'home' | 'away' | 'draw': what YES pays on (a soccer tie market pays on the draw).
    side: {
      type: 'string',
      // 'home', 'away' or 'draw'.
      required: true,
      fillable: true,
      validation: { rule: schema.enum(['home', 'away', 'draw']) },
      factory: () => 'home',
    },
    provider: {
      type: 'string',
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(40) },
      factory: () => 'DraftKings',
    },
    // The book's probability for YES with its margin removed, 0..1.
    bookProb: {
      type: 'number',
      // Four places: a 2-point gap is the whole question, and decimal(10,2) rounds it away.
      precision: 6,
      scale: 4,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.6,
    },
    kalshiBid: {
      type: 'number',
      // Four places: a 2-point gap is the whole question, and decimal(10,2) rounds it away.
      precision: 6,
      scale: 4,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.58,
    },
    kalshiAsk: {
      type: 'number',
      // Four places: a 2-point gap is the whole question, and decimal(10,2) rounds it away.
      precision: 6,
      scale: 4,
      required: true,
      fillable: true,
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0.6,
    },
    minutesToStart: {
      type: 'integer',
      required: true,
      fillable: true,
      validation: { rule: schema.number().min(-60).max(600) },
      factory: () => 30,
    },
    startsAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.soon().toISOString(),
    },
    recordedAt: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
