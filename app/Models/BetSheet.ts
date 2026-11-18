import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * BetSheet — a saved parlay a user is tracking.
 *
 * Owned by a User when signed in, or keyed to an anonymous `token` (the
 * same value the browser keeps in localStorage) so a guest's sheets can
 * be claimed on sign-up. Caches the leg count + parlay price for cheap
 * list rendering.
 */
export default defineModel({
  name: 'BetSheet',
  table: 'bet_sheets',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  attributes: {
    name: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().min(1).max(120) },
      factory: faker => `${faker.word.adjective()} parlay`,
    },
    // Anonymous owner token (localStorage) when there's no user_id.
    token: {
      type: 'string',
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: faker => faker.string.uuid(),
    },
    legCount: {
      type: 'number',
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 8 }),
    },
    parlayDecimal: {
      type: 'number',
      precision: 14,
      scale: 4,
      fillable: true,
      validation: { rule: schema.number().min(1) },
      factory: faker => faker.number.float({ min: 1.5, max: 50, fractionDigits: 2 }),
    },
  },

  belongsTo: ['User'],
  hasMany: ['BetSheetItem'],
} as const)
