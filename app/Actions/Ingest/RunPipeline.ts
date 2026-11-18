import { generateInsights, gradeInsights } from '../../Services/ai/insights'
import { ingestEspnFundamentals } from '../../Services/fundamentals/espn'
import { ingestEspn } from '../../Services/ingest/espn'
import { syncSports } from '../../Services/ingest/sports-sync'
import { ingestOdds } from '../../Services/ingest/odds'
import { watcherLive } from '../../Services/odds/watcher-heartbeat'
import { computeCalibration } from '../../Services/quant/calibration'
import { computeFairPrices } from '../../Services/quant/fair'
import { settle } from '../../Services/quant/settle'
import { captureFeatureSnapshots } from '../../Services/quant/snapshot'
import { openWrite } from '../../Support/db'

/**
 * The whole data loop, in the one order it can correctly run.
 *
 * Each stage consumes what the previous one produced, and running them out
 * of order does not fail loudly — it produces subtly stale numbers, which
 * is worse. Hence a single entry point rather than several independently
 * scheduled jobs that happen to be sequenced correctly today:
 *
 *  1. **Schedule** — fixtures and results must exist before prices have
 *     anything to attach to, and before anything can be graded.
 *  2. **Odds** — prices, and the history rows movement is derived from.
 *  3. **Fair prices** — de-vig and consensus over the prices just written.
 *  4. **Snapshots** — freeze the feature vector *after* fair values are
 *     current, or the training set records numbers no live caller saw.
 *  5. **Settle** — closing lines, grading, and CLV on anything finished.
 *  6. **Calibration** — rebuild the reliability curves from what settled.
 *  7. **AI** — review the candidates, and score the reviews that resolved.
 */
export default {
  name: 'RunPipeline',
  description: 'Run the full ingest, pricing, settlement, and review loop.',

  async handle(options: { skipAi?: boolean } = {}) {
    const db = openWrite()
    const startedAt = Date.now()

    try {
      // Reference data first: a league added to the model since the last
      // deploy has to exist before anything tries to ingest under it.
      await syncSports(db)
      const schedule = await ingestEspn(db)
      // Fundamentals ride with the schedule pass: both read team-level
      // facts, and standings are only meaningful once the fixtures they
      // describe exist. Neither blocks pricing, so a failure here leaves
      // the board working and shows up as a degraded provider instead.
      const fundamentals = await ingestEspnFundamentals(db)
      // Prices are the watcher's job while it runs; this stage is the floor.
      const odds = watcherLive() ? { skipped: 'odds:watch is running' as const } : await ingestOdds(db)
      const fair = await computeFairPrices(db)
      const snapshots = await captureFeatureSnapshots(db)
      const settlement = await settle(db)
      const calibration = await computeCalibration(db)

      // The AI pass is last and optional. It is the only stage that costs
      // money per run and the only one that can be absent without leaving
      // the rest of the pipeline incoherent.
      const ai = options.skipAi
        ? { requested: 0, generated: 0, cached: 0, skipped: 0, costUsd: 0, errors: ['skipped'] }
        : await generateInsights(db)
      const aiGraded = await gradeInsights(db)

      return {
        durationMs: Date.now() - startedAt,
        schedule,
        fundamentals,
        odds,
        fair,
        snapshots,
        settlement,
        calibration,
        ai: { ...ai, graded: aiGraded },
      }
    }
    finally {
      db.close()
    }
  },
}
