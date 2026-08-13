import { Job } from '@stacksjs/queue'
import RunAutoTradeAction from '../Actions/Trading/RunAutoTrade'
import { monitored } from '../Services/monitoring'

/**
 * The trading loop: score markets from the ingested tape, judge the
 * candidates, and place what the active strategies approve.
 *
 * Runs on a slower cadence than ingestion on purpose. The evidence
 * window is 24 hours, so a pass every five minutes would mostly
 * re-derive the same numbers while multiplying the chances of acting on
 * a momentary print. Thirty minutes is frequent enough to catch a real
 * move, conservative with AI/API spend, and slow enough that each pass
 * sees genuinely new tape.
 *
 * `tries: 1` — a retried trading pass is a second pass, not a resumed
 * one. The decisions upsert and orders carry an idempotency key, so a
 * retry would not double up, but a failed pass has nothing worth
 * resuming: the next scheduled run recomputes from current data anyway.
 */
export default new Job({
  name: 'AutoTrade',
  description: 'Score prediction markets, judge candidates, and place approved orders',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('AutoTrade', async () => {
    return RunAutoTradeAction.handle()
  }),
})
