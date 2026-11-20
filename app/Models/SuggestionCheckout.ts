import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'SuggestionCheckout', table: 'suggestion_checkouts', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  indexes: [{ name: 'suggestion_checkout_ticket', columns: ['bet_suggestion_id'], unique: true }],
  attributes: {
    payload: { type: 'text', required: true, fillable: true, validation: { rule: schema.string() }, factory: () => '{}' },
    betSuggestionId: { type: 'number', required: true, fillable: true, validation: { rule: schema.number().min(1) }, factory: () => 1 },
  },
} as const)
