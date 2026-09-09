import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'PredictionGroup', table: 'prediction_groups',
  traits: { useTimestamps: true },
  attributes: {
    ownerId: { required: true, validation: { rule: schema.number().integer().min(1) } },
    name: { required: true, validation: { rule: schema.string().min(2).max(80) } },
    description: { default: '', validation: { rule: schema.string().max(500) } },
  },
} as const)
