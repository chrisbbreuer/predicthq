import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A source article, post, show segment, or newsletter carrying analysis. */
export default defineModel({
  name: 'ExpertOpinion',
  table: 'expert_opinions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
    useSearch: {
      searchable: ['title', 'summary', 'excerpt', 'sport', 'league'],
      sortable: ['published_at', 'created_at'],
      filterable: ['content_type', 'sport', 'league', 'paywalled'],
    },
  },

  indexes: [
    { name: 'expert_opinions_source_external', columns: ['expert_source_id', 'external_id'], unique: true },
    { name: 'expert_opinions_expert_published', columns: ['expert_profile_id', 'published_at'] },
    { name: 'expert_opinions_document', columns: ['source_document_id'] },
    { name: 'expert_opinions_sport_published', columns: ['sport', 'published_at'] },
  ],

  attributes: {
    externalId: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(240) }, factory: faker => faker.string.alphanumeric(20) },
    sourceDocumentId: {
      type: 'number', fillable: true,
      foreignKey: { table: 'source_documents', column: 'id', onDelete: 'set null', nullable: true },
      validation: { rule: schema.number().min(1) }, factory: () => null,
    },
    url: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(1500) }, factory: () => 'https://example.com/pick' },
    canonicalUrl: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1500) }, factory: () => '' },
    title: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(500) }, factory: faker => faker.lorem.sentence() },
    contentType: {
      type: 'string', required: true, fillable: true, default: 'article',
      validation: { rule: schema.enum(['article', 'pick_card', 'newsletter', 'podcast', 'video', 'social', 'manual']) },
      factory: () => 'article',
    },
    sport: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(60) }, factory: () => '' },
    league: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(80) }, factory: () => '' },
    summary: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(1200) }, factory: () => '' },
    excerpt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(4000) }, factory: () => '' },
    language: { type: 'string', fillable: true, default: 'en', validation: { rule: schema.string().max(12) }, factory: () => 'en' },
    paywalled: { type: 'boolean', fillable: true, default: false, validation: { rule: schema.boolean() }, factory: () => false },
    publishedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(40) }, factory: () => new Date().toISOString() },
    ingestedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().min(1).max(40) }, factory: () => new Date().toISOString() },
    parserVersion: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) }, factory: () => '' },
    contentHash: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(64) }, factory: () => '' },
  },

  belongsTo: ['ExpertSource', 'ExpertProfile'],
  hasMany: ['ExpertPick'],
} as const)
