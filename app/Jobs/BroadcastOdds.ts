import { Job } from '@stacksjs/queue'
import BroadcastBoard from '../Actions/Odds/BroadcastBoard'
import { monitored } from '../Services/monitoring'

/**
 * Pushes the latest odds board to realtime subscribers on a cadence.
 * Reuses the BroadcastBoard action so the same logic backs the schedule,
 * a manual dispatch, and a price-change event. Scheduled in
 * app/Scheduler.ts.
 */
export default new Job({
  name: 'BroadcastOdds',
  description: 'Broadcast the latest odds board to the realtime `odds` channel',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('BroadcastOdds', async () => {
    return BroadcastBoard.handle()
  }),
})
