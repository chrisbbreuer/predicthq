import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * ApiKey — a caller the API can name.
 *
 * The public endpoints were throttled by IP, which is the only thing an
 * anonymous request offers and a poor stand-in for a caller: it punishes
 * an office behind one address and does nothing about a caller with
 * several. The bulk export in particular hands out thousands of rows a
 * request to anyone who asks, and there was no way to say who had asked
 * or how often.
 *
 * The secret is stored as a SHA-256 digest and shown exactly once, at
 * creation. A key that can be read back out of the database is a
 * password stored in plaintext with extra steps, and there is no reason
 * to be able to: a lost key is replaced, not recovered.
 */
export default defineModel({
  name: 'ApiKey',
  table: 'api_keys',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'user', columns: ['userId'] },
    // The lookup every authenticated request does. Unique because the
    // prefix is what identifies which secret to check.
    { name: 'prefix', columns: ['prefix'], unique: true },
  ],

  attributes: {
    userId: {
      type: 'bigint',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },
    // What the user calls it. Keys are replaced, not recovered, so the
    // only way to know which one to revoke is what it was named.
    name: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(80) },
      factory: faker => `${faker.word.adjective()} key`,
    },
    // The public half, sent in the clear and safe to display. Identifies
    // which key is being presented without revealing it.
    prefix: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().min(1).max(40) },
      factory: faker => faker.string.alphanumeric(12),
    },
    // SHA-256 of the secret half. Never reversed, only compared.
    hash: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => faker.string.alphanumeric(64),
    },
    lastUsedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
    // Revoked keys are kept rather than deleted: the usage recorded
    // against them is the answer to "what was this key doing before we
    // turned it off", which is the question asked at exactly the moment
    // someone turns one off.
    revokedAt: {
      type: 'string',
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },
  },
} as const)
