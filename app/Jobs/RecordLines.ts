import { Job } from '@stacksjs/queue'
import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { recordLines } from '../Services/trading/line-snapshots'

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
      return await recordLines(db)
    }
    finally {
      db.close()
    }
  }),
})
