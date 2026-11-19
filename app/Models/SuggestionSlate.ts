import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** An account's named set of suggestions and their existing paper tracking records. */
export default defineModel({
  name: 'SuggestionSlate',
  table: 'suggestion_slates',
  primaryKey: 'id',
  autoIncrement: true,
  belongsTo: ['User'],
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  indexes: [{ name: 'suggestion_slates_user_created', columns: ['user_id', 'created_at'] }],
  attributes: {
    name: {
      type: 'string',
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => 'Evening slate',
    },
    tickets: {
      type: 'text',
      required: true,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => '[]',
    },
  },
})
