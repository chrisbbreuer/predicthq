import type { Database } from '../../Support/db'
import { nowIso } from '../../Support/keys'

/**
 * Calibration: does a stated 70% actually happen 70% of the time?
 *
 * This is the only question that matters about a probabilistic estimate,
 * and accuracy cannot answer it. A model that says 55% on every home
 * favourite scores well on accuracy and is badly calibrated, and staking
 * against it loses money precisely on the bets it is most confident about.
 *
 * Settled snapshots are bucketed by predicted probability and each
 * bucket's mean prediction compared to its observed hit rate. On a
 * calibrated model the two track closely; a systematic gap is a bias with
 * a direction, which is correctable.
 *
 * Both Brier score and log loss are recorded because they fail
 * differently: Brier is bounded and relatively forgiving of a confident
 * miss, log loss is unbounded and punishes one severely. A model can hold
 * steady on one while the other quietly deteriorates, so tracking a single
 * number hides a real failure mode.
 */

/** Ten buckets of 0.1. Fine enough to show shape, coarse enough to fill. */
const BUCKET_COUNT = 10

/** Log loss is unbounded at 0 and 1, so predictions are clamped inside. */
const EPSILON = 1e-15

export interface CalibrationResult {
  scopes: number
  buckets: number
  sampleSize: number
  overallBrier: number
  overallLogLoss: number
}

interface LabelledRow {
  fair_prob: number
  label: number
  clv_pct: number
  sport_slug: string
  market_type: string
}

interface Scope {
  scope: string
  scopeKey: string
  rows: LabelledRow[]
}

/**
 * Rebuild every calibration curve from the labelled snapshot history.
 *
 * Recomputed wholesale rather than incrementally: the table is small, the
 * inputs are immutable once labelled, and a full rebuild cannot drift out
 * of sync with its source the way an incremental one can.
 */
export async function computeCalibration(db: Database): Promise<CalibrationResult> {
  // Pushes are excluded: a voided market has no outcome to be right or
  // wrong about, and scoring it either way would distort the curve.
  const raw = await db.query<Record<string, unknown>>(`
    SELECT fair_prob, label, clv_pct, sport_slug, market_type
    FROM feature_snapshots
    WHERE label IN (0, 1) AND fair_prob > 0
  `).all()
  // Vitess returns DECIMAL columns as strings; summed, they concatenate,
  // and the NaN that comes out failed every pipeline run once games settled.
  const finite = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const rows: LabelledRow[] = raw.map(row => ({
    fair_prob: finite(row.fair_prob),
    label: finite(row.label),
    clv_pct: finite(row.clv_pct),
    sport_slug: String(row.sport_slug ?? ''),
    market_type: String(row.market_type ?? ''),
  }))

  if (rows.length === 0)
    return { scopes: 0, buckets: 0, sampleSize: 0, overallBrier: 0, overallLogLoss: 0 }

  // Keyed by a tuple rather than a joined string, so no separator
  // character has to be assumed absent from every sport slug and bet type.
  const scopes = new Map<string, Scope>()
  const add = (scope: string, scopeKey: string, row: LabelledRow) => {
    const id = JSON.stringify([scope, scopeKey])
    const entry = scopes.get(id) ?? { scope, scopeKey, rows: [] }
    entry.rows.push(row)
    scopes.set(id, entry)
  }

  // The same row feeds several curves. A model is often well calibrated in
  // aggregate while being badly skewed inside one league or bet type, and
  // only the segmented view exposes that.
  for (const row of rows) {
    add('overall', '', row)
    if (row.sport_slug)
      add('sport', row.sport_slug, row)
    if (row.market_type)
      add('market_type', row.market_type, row)
  }

  const now = nowIso()
  let bucketsWritten = 0
  let overallBrier = 0
  let overallLogLoss = 0

  await db.transaction(async (transaction) => {
    for (const entry of scopes.values()) {
      for (let i = 0; i < BUCKET_COUNT; i++) {
        const lower = i / BUCKET_COUNT
        const upper = (i + 1) / BUCKET_COUNT
        // The final bucket is closed at the top so a prediction of exactly
        // 1.0 lands somewhere rather than being silently dropped.
        const inBucket = entry.rows.filter(r =>
          r.fair_prob >= lower && (i === BUCKET_COUNT - 1 ? r.fair_prob <= upper : r.fair_prob < upper),
        )

        if (inBucket.length === 0)
          continue

        const brier = mean(inBucket.map(r => (r.fair_prob - r.label) ** 2))
        const logLoss = mean(inBucket.map((r) => {
          const p = Math.min(1 - EPSILON, Math.max(EPSILON, r.fair_prob))
          return -(r.label * Math.log(p) + (1 - r.label) * Math.log(1 - p))
        }))

        await transaction.updateOrInsert('calibration_buckets', {
          scope: entry.scope,
          scope_key: entry.scopeKey,
          bucket_lower: lower,
        }, {
          bucket_upper: upper,
          predicted_avg: mean(inBucket.map(r => r.fair_prob)),
          observed_rate: mean(inBucket.map(r => r.label)),
          sample_size: inBucket.length,
          brier_score: brier,
          log_loss: logLoss,
          avg_clv_pct: mean(inBucket.map(r => r.clv_pct)),
          computed_at: now,
          updated_at: now,
        })
        bucketsWritten++

        if (entry.scope === 'overall') {
          overallBrier += brier * inBucket.length
          overallLogLoss += logLoss * inBucket.length
        }
      }
    }
  })

  return {
    scopes: scopes.size,
    buckets: bucketsWritten,
    sampleSize: rows.length,
    overallBrier: overallBrier / rows.length,
    overallLogLoss: overallLogLoss / rows.length,
  }
}

function mean(values: number[]): number {
  if (values.length === 0)
    return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export { BUCKET_COUNT }
