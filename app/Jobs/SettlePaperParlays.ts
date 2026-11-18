import { Job } from '@stacksjs/queue'
import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { settlePaperParlays } from '../Services/trading/paper-parlays'

/** Settle paper parlays once their legs have. See app/Services/trading/paper-parlays.ts. */
export default new Job({
  name: 'SettlePaperParlays',
  description: 'Settle simulated parlays from the results of their legs',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('SettlePaperParlays', async () => {
    const db = new Database()
    try {
      return await settlePaperParlays(db)
    }
    finally {
      db.close()
    }
  }),
})
