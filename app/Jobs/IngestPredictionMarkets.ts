import { Job } from '@stacksjs/queue'
import IngestPredictionMarketsAction from '../Actions/PredictionMarkets/IngestPredictionMarkets'
import { monitored } from '../Services/monitoring'

/**
 * The prediction-market data loop: pull the public Kalshi + Polymarket
 * trade tapes, persist markets/traders/fills, and refresh the smart-money
 * analytics. Reuses the IngestPredictionMarkets action so the same logic
 * runs from the schedule, a CLI dispatch, or a route. Scheduled in
 * app/Scheduler.ts.
 */
export default new Job({
  name: 'IngestPredictionMarkets',
  description: 'Ingest public prediction-market trades and refresh smart-money analytics',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('IngestPredictionMarkets', async () => {
    return IngestPredictionMarketsAction.handle()
  }),
})
