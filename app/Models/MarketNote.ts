import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * MarketNote - one person's take on one market.
 *
 * The discussion surface. Threads are per market rather than global,
 * because "what do we think about this contract" is the only conversation
 * that stays useful once it is a week old; a general chat room is not.
 *
 * The framework's `commentable` trait was the first choice, but it targets
 * a `commentables` table this app has never had and enabling it emitted no
 * migration. An explicit model is the honest version: the columns are
 * visible, the natural key is enforceable, and the moderation state is ours
 * rather than inherited.
 *
 * `stance` is what makes this more than a comment box. A note is attached
 * to a side, so a market's thread can be counted as well as read, and the
 * count is what the page leads with.
 */
export default defineModel({
  name: 'MarketNote',
  table: 'market_notes',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  indexes: [
    // The thread read: newest note on a given market.
    { name: 'market_created', columns: ['predictionMarketId', 'created_at'] },
    // A person's own history.
    { name: 'author', columns: ['userId'] },
  ],

  attributes: {
    predictionMarketId: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.int({ min: 1, max: 100 }),
    },

    // Null for a note left before signing in. Not 0: user_id carries a
    // foreign key, and 0 is a user id that does not exist rather than an
    // absent one, so the constraint rejects it.
    //
    // The display name is stored alongside rather than joined, so a thread
    // renders in one query and survives the account being deleted.
    userId: {
      type: 'bigint',
      fillable: true,
      validation: { rule: schema.number().min(1).optional() },
      factory: () => null,
    },

    authorName: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(60) },
      factory: faker => faker.internet.username(),
    },

    // 'yes' | 'no' | 'watching'. Watching is the honest default: most
    // people reading a market have not taken a side yet, and forcing one
    // would make the counts read as conviction that is not there.
    stance: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(10) },
      factory: faker => faker.helpers.arrayElement(['yes', 'no', 'watching']),
    },

    body: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(1000) },
      factory: faker => faker.lorem.sentence(),
    },

    // Soft moderation. Hiding a note keeps the row, so a thread can be
    // cleaned up without losing the record of what was said.
    hidden: {
      type: 'boolean',
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
})
