import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function () {
  // Run the Inspire job every hour
  schedule
    .job('Inspire')
    .hourly()
    .setTimeZone('America/Los_Angeles')

  // The full data loop: fixtures and results from ESPN, then prices, then
  // de-vig and fair value, then feature capture, settlement, calibration,
  // and the AI review. Scheduled as one job rather than several because
  // each stage consumes what the previous one produced, and running them
  // out of order does not fail loudly — it produces subtly stale numbers.
  //
  // Prices are the one stage that also has a faster path. `buddy
  // odds:watch` polls the books on a per-league cadence measured in
  // seconds, which cron cannot express — its floor is one minute, and a
  // game in play needs better than that. The pass here still ingests
  // prices, deliberately: it is the floor that keeps the board moving when
  // the watch process is not running, and writing the same unchanged price
  // twice costs nothing because history is appended only on change.
  //
  // See app/Actions/Ingest/RunPipeline.ts for the ordering and why.
  schedule
    .job('RunPipeline')
    .everyFiveMinutes()

  // These are kept explicit rather than also giving the Job objects a
  // `rate`. Stacks auto-discovers rated jobs and normalizes their names to
  // snake_case before resolving the filename; mixing both paths duplicates
  // every run and asks for files such as `app/Jobs/ingest_odds.ts` while the
  // source-of-truth job is `app/Jobs/IngestOdds.ts`.
  schedule
    .job('IngestOdds')
    .everyMinute()

  schedule
    .job('BroadcastOdds')
    .everyMinute()

  // Prediction-market loop: the public Kalshi and Polymarket trade tapes
  // plus the smart-money analytics over them. Separate from the pipeline
  // above because it reads a different set of venues on its own cadence.
  schedule
    .job('IngestPredictionMarkets')
    .everyFiveMinutes()

  // Trading loop: score markets from that tape, judge the candidates, and
  // place what the active strategies approve. Slower than ingestion on
  // purpose — the evidence window is 24h, so a faster pass mostly
  // re-derives the same numbers. See app/Jobs/AutoTrade.ts.
  schedule
    .job('AutoTrade')
    .everyThirtyMinutes()

  // Reconciliation runs far more often than the loop that places the
  // orders. A fill arrives whenever someone crosses, and until it has
  // been read back every risk check downstream is working from what was
  // true at placement. See app/Jobs/SyncOrders.ts.
  schedule
    .job('SyncOrders')
    .everyMinute()

  // Asks whether the loops above are still producing. Outside them on
  // purpose: a check that runs inside the pass it watches cannot report
  // the pass never running. See app/Services/watchdog.ts.
  schedule
    .job('Watchdog')
    .everyFiveMinutes()

  // Transfermarkt career history is intentionally outside the five-minute
  // pricing loop. This bounded pass resumes durable tasks, refreshes mutable
  // squad/injury pages by TTL, and never downloads immutable history merely
  // because the market pipeline ran again.
  schedule
    .job('RefreshTransfermarkt')
    .daily()
    .at('02:30')
    .setTimeZone('Europe/Berlin')

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
