import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Durable, private history snapshot. A failed refresh never replaces the last good import. */
export default defineModel({
  name: 'ExchangeHistory', table: 'exchange_histories',
  traits: { useTimestamps: true },
  attributes: {
    exchangeAccountId: { required: true, unique: true, foreignKey: false, validation: { rule: schema.number().integer().min(1) } },
    payload: { type: 'json', hidden: true, nullable: true, validation: { rule: schema.string() } },
    syncedAt: { type: 'datetime', nullable: true, validation: { rule: schema.date() } },
    attemptedAt: { type: 'datetime', nullable: true, validation: { rule: schema.date() } },
    lastError: { default: '', validation: { rule: schema.string().max(500) } },
  },
} as const)
