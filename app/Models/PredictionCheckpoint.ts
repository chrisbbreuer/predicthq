import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Immutable winner quote and context observed before the T-30 cutoff. */
export default defineModel({
  name: 'PredictionCheckpoint',
  table: 'prediction_checkpoints',
  primaryKey: 'id',
  autoIncrement: true,
  indexes: [
    { name: 'prediction_checkpoints_event_capture', columns: ['event_ticker', 'captured_at'], unique: true },
    { name: 'prediction_checkpoints_start', columns: ['start_at'] },
    { name: 'prediction_checkpoints_ticker', columns: ['ticker'] },
  ],
  attributes: {
    eventTicker: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(80) } },
    ticker: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(80) } },
    league: { type: 'string', required: true, fillable: true, validation: { rule: schema.string().max(32) } },
    startAt: { type: 'datetime', required: true, fillable: true, validation: { rule: schema.string() } },
    capturedAt: { type: 'datetime', required: true, fillable: true, validation: { rule: schema.string() } },
    settledAt: { type: 'string', fillable: true, default: '', validation: { rule: schema.string().max(40) } },
    result: { type: 'string', fillable: true, validation: { rule: schema.string().max(8) } },
    payload: { type: 'text', required: true, fillable: true, validation: { rule: schema.string() } },
    createdAt: { type: 'datetime', required: true, fillable: true, validation: { rule: schema.string() } },
  },
} as const)
