import { Job } from '@stacksjs/queue'
import SyncOrdersAction from '../Actions/Trading/SyncOrders'
import { monitored } from '../Services/monitoring'

/**
 * Reconcile open orders with the venues that hold them.
 *
 * Every minute, unlike the fifteen-minute trading loop, because the two
 * are answering different questions. Placement decides slowly on a
 * twenty-four hour evidence window; a fill happens whenever someone
 * crosses, and until this job has seen it the position cap, the bankroll
 * check, and the daily loss limit are all working from what was true at
 * placement rather than what is true now.
 *
 * `tries: 1` — reconciliation is idempotent and the next minute's pass
 * picks up anything this one could not reach, so a retry adds nothing a
 * wait does not.
 */
export default new Job({
  name: 'SyncOrders',
  description: 'Reconcile open exchange orders against the venue',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('SyncOrders', async () => {
    return SyncOrdersAction.handle()
  }),
})
