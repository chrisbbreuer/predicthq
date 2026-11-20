import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** The game forecast actually recorded before play, with the inputs available then. */
export default defineModel({
  name: 'GameScoreForecast', table: 'game_score_forecasts', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  indexes: [{ name: 'game_score_forecasts_event_start', columns: ['market_event_id', 'start_at'], unique: true }],
  attributes: {
    payload: { type: 'text', required: true, fillable: true, validation: { rule: schema.string() }, factory: () => '{}' },
    startAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => new Date().toISOString() },
    capturedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => new Date().toISOString() },
  },
  belongsTo: ['MarketEvent'],
} as const)
