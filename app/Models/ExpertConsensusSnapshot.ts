import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A time-stamped, performance-weighted aggregate of normalized expert picks. */
export default defineModel({
  name: 'ExpertConsensusSnapshot',
  table: 'expert_consensus_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  indexes: [
    { name: 'expert_consensus_target_time', columns: ['target_key', 'as_of_at'], unique: true },
    { name: 'expert_consensus_event', columns: ['market_event_id'] },
    { name: 'expert_consensus_selection', columns: ['selection_id'] },
  ],

  attributes: {
    targetKey: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(240) }, factory: faker => faker.string.alphanumeric(32) },
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
    marketType: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(80) }, factory: () => '' },
    side: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(240) }, factory: () => '' },
    line: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    hasLine: { type: 'boolean', fillable: true, default: false, validation: { rule: schema.boolean() }, factory: () => false },
    expertCount: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    pickCount: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    agreement: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
    weightedProbability: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
    weightedEdge: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    meanConfidence: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
    totalUnits: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    asOfAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(40) }, factory: () => new Date().toISOString() },
    methodologyVersion: { type: 'string', required: true, fillable: true, default: 'v1', validation: { rule: schema.string().min(1).max(40) }, factory: () => 'v1' },
  },

  belongsTo: ['Market'],
} as const)
