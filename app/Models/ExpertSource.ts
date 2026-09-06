import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A publisher or authorized delivery channel for expert intelligence. */
export default defineModel({
  name: 'ExpertSource',
  table: 'expert_sources',
  primaryKey: 'id',
  autoIncrement: true,

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  indexes: [
    { name: 'expert_sources_key', columns: ['key'], unique: true },
    { name: 'expert_sources_status_policy', columns: ['status', 'access_policy'] },
  ],

  attributes: {
    key: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(80) }, factory: () => 'sportsline' },
    name: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(160) }, factory: () => 'SportsLine' },
    homepageUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    termsUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    robotsUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    acquisition: {
      type: 'string', required: true, fillable: true, default: 'licensed_feed',
      validation: { rule: schema.enum(['licensed_feed', 'official_api', 'rss', 'authorized_email', 'public_web', 'manual']) },
      factory: () => 'licensed_feed',
    },
    accessPolicy: {
      type: 'string', required: true, fillable: true, default: 'review_required',
      validation: { rule: schema.enum(['allowed', 'permission_required', 'blocked_by_terms', 'review_required']) },
      factory: () => 'review_required',
    },
    status: {
      type: 'string', required: true, fillable: true, default: 'planned',
      validation: { rule: schema.enum(['ready', 'planned', 'active', 'paused', 'blocked']) },
      factory: () => 'planned',
    },
    parserKey: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(80) }, factory: () => '' },
    priority: { type: 'integer', fillable: true, default: 3, validation: { rule: schema.number().min(1).max(3) }, factory: () => 3 },
    pollMinutes: { type: 'integer', fillable: true, default: 60, validation: { rule: schema.number().min(1).max(10080) }, factory: () => 60 },
    attributionRequired: { type: 'boolean', fillable: true, default: true, validation: { rule: schema.boolean() }, factory: () => true },
    retentionDays: { type: 'integer', fillable: true, default: 365, validation: { rule: schema.number().min(0) }, factory: () => 365 },
    coverage: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    notes: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(2000) }, factory: () => '' },
    lastPolicyReviewAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    lastSuccessfulIngestAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
  },

  hasMany: ['ExpertProfile', 'ExpertOpinion', 'ExpertPick'],
} as const)
