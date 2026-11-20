import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { captureGameBoxes } from '../Services/scores/box-history'

export default {
  handle: monitored('CollectGameBoxes', async () => {
    const db = new Database()
    try {
      return await captureGameBoxes(db)
    }
    finally {
      db.close()
    }
  }),
}
