import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { recordLines } from '../Services/trading/line-snapshots'
import { auditRecordedCheckpoints, MIN_PAIRED_CHECKPOINTS, settlePredictionCheckpoints } from '../Services/trading/prediction-checkpoints'

/**
 * Record Kalshi's quote beside the sportsbook line for games starting within
 * three hours, every five minutes, so `buddy trading:lines` can score whether
 * the book leads Kalshi. See app/Services/trading/line-snapshots.ts.
 */
export default new Job({
  name: 'RecordLines',
  description: 'Snapshot Kalshi quotes next to the sportsbook line before each game',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('RecordLines', async () => {
    const db = new Database()
    try {
      const capture = await recordLines(db, undefined, true)
      if (capture.checkpoints)
        log.info(`[PredictionCheckpoints] captured ${capture.checkpoints} checkpoints, ${capture.paired} paired, ${capture.oddsPapiObservations} OddsPapi offers saved`)
      if (new Date().getUTCMinutes() < 10 && await settlePredictionCheckpoints(db) > 0) {
        const report = await auditRecordedCheckpoints(db)
        if (report.sportsbookOnlyContext.scores)
          log.info(`[PredictionCheckpoints] sportsbook-only audit ${JSON.stringify(report.sportsbookOnlyContext)}`)
        if (report.pairedSettled >= MIN_PAIRED_CHECKPOINTS || report.marketContext.context!.games >= 50)
          log.info(`[PredictionCheckpoints] settled audit ${JSON.stringify(report)}`)
      }
      return capture
    }
    finally {
      db.close()
    }
  }),
})
