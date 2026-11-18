import { Job } from '@stacksjs/queue'
import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { settleHeldPositions, settlePaperParlays } from '../Services/trading/paper-parlays'

/**
 * Settle paper bets as soon as their markets resolve: parlays from their legs'
 * results, and singles by refreshing the markets open positions hold. See
 * app/Services/trading/paper-parlays.ts.
 */
export default new Job({
  name: 'SettlePaperParlays',
  description: 'Settle paper parlays and refresh results for markets that positions hold',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('SettlePaperParlays', async () => {
    const db = new Database()
    try {
      const parlays = await settlePaperParlays(db)
      const singles = await settleHeldPositions(db)
      return { parlays, singles }
    }
    finally {
      db.close()
    }
  }),
})
