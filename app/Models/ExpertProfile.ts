import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** One source-native identity for an analyst, model, show, or staff desk. */
export default defineModel({
  name: 'ExpertProfile',
  table: 'expert_profiles',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
    useSearch: { searchable: ['name', 'handle', 'bio', 'specialties'], sortable: ['name', 'created_at'], filterable: ['kind', 'active'] },
  },

  indexes: [
    { name: 'expert_profiles_source_external', columns: ['expert_source_id', 'external_id'], unique: true },
    { name: 'expert_profiles_name', columns: ['name'] },
    { name: 'expert_profiles_active', columns: ['active'] },
  ],

  attributes: {
    externalId: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(200) }, factory: () => 'staff' },
    name: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(200) }, factory: faker => faker.person.fullName() },
    handle: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(160) }, factory: () => '' },
    kind: {
      type: 'string', required: true, fillable: true, default: 'human',
      validation: { rule: schema.enum(['human', 'model', 'desk', 'show', 'community']) },
      factory: () => 'human',
    },
    profileUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    avatarUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    bio: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(4000) }, factory: () => '' },
    specialties: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1000) }, factory: () => '' },
    active: { type: 'boolean', fillable: true, default: true, validation: { rule: schema.boolean() }, factory: () => true },
    verified: { type: 'boolean', fillable: true, default: false, validation: { rule: schema.boolean() }, factory: () => false },
    firstSeenAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    lastSeenAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
  },

  belongsTo: ['ExpertSource'],
  hasMany: ['ExpertOpinion', 'ExpertPick', 'ExpertPerformanceSnapshot'],
} as const)
