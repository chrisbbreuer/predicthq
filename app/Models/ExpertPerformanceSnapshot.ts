import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Reproducible rolling performance for weighting experts without survivorship edits. */
export default defineModel({
  name: 'ExpertPerformanceSnapshot',
  table: 'expert_performance_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  indexes: [
    { name: 'expert_perf_scope', columns: ['expert_profile_id', 'sport', 'market_type', 'window_days', 'as_of_at'], unique: true },
    { name: 'expert_perf_as_of', columns: ['as_of_at'] },
  ],

  attributes: {
    sport: { type: 'string', fillable: true, default: 'all', validation: { rule: schema.string().max(60) }, factory: () => 'all' },
    marketType: { type: 'string', fillable: true, default: 'all', validation: { rule: schema.string().max(80) }, factory: () => 'all' },
    windowDays: { type: 'integer', required: true, fillable: true, default: 365, validation: { rule: schema.number().min(1).max(3650) }, factory: () => 365 },
    sampleSize: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    wins: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    losses: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    pushes: { type: 'integer', fillable: true, default: 0, validation: { rule: schema.number().min(0) }, factory: () => 0 },
    winRate: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0).max(1) }, factory: () => 0 },
    unitsRisked: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    profitUnits: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    roi: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    avgClvPct: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float() }, factory: () => 0 },
    brierScore: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    calibrationError: { type: 'number', fillable: true, default: 0, validation: { rule: schema.float().min(0) }, factory: () => 0 },
    asOfAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(40) }, factory: () => new Date().toISOString() },
    methodologyVersion: { type: 'string', required: true, fillable: true, default: 'v1', validation: { rule: schema.string().min(1).max(40) }, factory: () => 'v1' },
  },

  belongsTo: ['ExpertProfile'],
} as const)
