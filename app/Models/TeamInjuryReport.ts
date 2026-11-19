import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A full team report, including an empty list when no injuries are listed. */
export default defineModel({
  name: 'TeamInjuryReport', table: 'team_injury_reports', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  indexes: [{ name: 'team_injury_reports_team_captured', columns: ['sports_team_id', 'captured_at'] }],
  attributes: {
    injuries: { type: 'text', required: true, fillable: true, validation: { rule: schema.string() }, factory: () => '[]' },
    source: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => 'espn' },
    capturedAt: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(40) }, factory: () => new Date().toISOString() },
  },
  belongsTo: ['SportsTeam'],
} as const)
