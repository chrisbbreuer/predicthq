import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { captureGameBoxes } from '../Services/scores/box-history'
import { captureScoreForecasts } from '../Services/scores/score-forecast'

export default {
  handle: monitored('CollectGameBoxes', async () => {
    const db = new Database()
    try {
      const [boxes, forecasts] = await Promise.all([captureGameBoxes(db), captureScoreForecasts(db)])
      return { boxes, forecasts }
    }
    finally {
      db.close()
    }
  }),
}
