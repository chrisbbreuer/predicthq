import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** One normalized wager recommendation extracted from an expert opinion. */
export default defineModel({
  name: 'ExpertPick',
  table: 'expert_picks',
  primaryKey: 'id',
  autoIncrement: true,

  traits: { useTimestamps: true, useSeeder: { count: 0 }, observe: true },

  indexes: [
    { name: 'expert_picks_source_fingerprint', columns: ['expert_source_id', 'fingerprint'], unique: true },
    { name: 'expert_picks_expert_published', columns: ['expert_profile_id', 'published_at'] },
    { name: 'expert_picks_event', columns: ['market_event_id'] },
    { name: 'expert_picks_selection', columns: ['selection_id'] },
    { name: 'expert_picks_status_starts', columns: ['status', 'starts_at'] },
  ],

  attributes: {
    fingerprint: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().length(64) }, factory: faker => faker.string.hexadecimal({ length: 64, prefix: '' }) },
    externalId: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(240) }, factory: () => '' },
    marketEventId: {
      type: 'number', fillable: true,
      foreignKey: { table: 'market_events', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) }, factory: () => null,
    },
    selectionId: {
      type: 'number', fillable: true,
      foreignKey: { table: 'selections', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) }, factory: () => null,
    },
    sport: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(60) }, factory: () => '' },
    league: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(80) }, factory: () => '' },
    eventTitle: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(300) }, factory: () => '' },
    marketType: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(80) }, factory: () => 'moneyline' },
    period: { type: 'string', fillable: true, default: 'full_game', validation: { rule: schema.string().max(60) }, factory: () => 'full_game' },
    side: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(240) }, factory: () => 'home' },
    line: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    hasLine: { type: 'boolean', fillable: true, default: false, validation: { rule: schema.boolean() }, factory: () => false },
    oddsAmerican: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(-100000).max(100000) }, factory: () => 0 },
    oddsDecimal: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    sportsbook: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(100) }, factory: () => '' },
    units: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    confidence: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
    rationale: { type: 'text', fillable: true, default: '', validation: { rule: schema.string() }, factory: () => '' },
    startsAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    publishedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(40) }, factory: () => new Date().toISOString() },
    lastSeenAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    status: {
      type: 'string', required: true, fillable: true, default: 'pending',
      validation: { rule: schema.enum(['pending', 'won', 'lost', 'push', 'void', 'ungraded']) },
      factory: () => 'pending',
    },
    resultedAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    closingOddsDecimal: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    clvPct: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    profitUnits: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    matchedBy: {
      type: 'string', fillable: true, default: 'unmatched',
      validation: { rule: schema.enum(['unmatched', 'external_id', 'rotation_number', 'team_pair', 'fuzzy', 'manual']) },
      factory: () => 'unmatched',
    },
    matchConfidence: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
  },

  belongsTo: ['ExpertSource', 'ExpertProfile', 'ExpertOpinion', 'Market'],
} as const)
