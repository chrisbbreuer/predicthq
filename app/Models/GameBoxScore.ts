import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Final team and player statistics from the source's event summary. */
export default defineModel({
  name: 'GameBoxScore', table: 'game_box_scores', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  indexes: [{ name: 'game_box_scores_event', columns: ['market_event_id'], unique: true }],
  attributes: {
    payload: { type: 'text', required: true, fillable: true, validation: { rule: schema.string() }, factory: () => '{}' },
    source: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => 'espn' },
    capturedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => new Date().toISOString() },
  },
  belongsTo: ['MarketEvent'],
} as const)
