import { Job } from '@stacksjs/queue'
import IngestOddsAction from '../Actions/Ingest/IngestOdds'
import { monitored } from '../Services/monitoring'

/**
 * The live data loop: pull fresh prices from the active provider, persist
 * them with snapshot history, and broadcast the refreshed board. Reuses
 * the IngestOdds action so the same logic runs from the schedule, a CLI
 * dispatch, or a route. Scheduled in app/Scheduler.ts.
 */
export default new Job({
  name: 'IngestOdds',
  description: 'Fetch + persist the latest odds and broadcast the refreshed board',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('IngestOdds', async () => {
    return IngestOddsAction.handle()
  }),
})
