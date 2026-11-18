import type { CLI } from '@stacksjs/types'
import type { ScheduledEvent } from '../Services/odds/engine'
import process from 'node:process'
import { log } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { Database } from '../Support/db'
import { pollableSports } from '../Services/ingest/odds'
import { enableIdentityMemo } from '../Services/ingest/resolve'
import { BEAT_MS, beat, clearBeat } from '../Services/odds/watcher-heartbeat'
import { IngestRunTracker } from '../Services/ingest/run'
import { activeAdapters, booksWithoutAdapters } from '../Services/odds/books'
import { bookContextFor } from '../Services/odds/context'
import { OddsEngine } from '../Services/odds/engine'
import { PushBuffer, writePushed } from '../Services/odds/push-buffer'

/**
 * `buddy odds:watch` — the long-running price loop.
 *
 * The fourth runtime role, alongside web, realtime, and scheduler. It
 * exists because cron cannot go below one minute and a live game needs
 * seconds; see `app/Services/odds/engine.ts` for the full argument.
 *
 * Run it under a supervisor that restarts it. It is deliberately not
 * resilient to its own process dying — a price loop that has stopped
 * should stop, loudly, and be restarted, rather than limp along in a state
 * nobody can reason about. The `Watchdog` job is what notices the board
 * has gone stale either way.
 */

/**
 * Events that drive the schedule.
 *
 * Only what is unfinished and not absurdly far out: a fixture list that
 * runs a year ahead would put thousands of rows through the bucket
 * calculation every refresh to conclude, every time, that they are all in
 * the slowest bucket.
 */
async function loadScheduledEvents(db: Database): Promise<ScheduledEvent[]> {
  const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  return await db.query<ScheduledEvent>(`
    SELECT s.slug AS sportSlug, e.commence_at AS commenceAt, e.status AS status
    FROM market_events e
    JOIN sports s ON s.id = e.sport_id
    WHERE e.status NOT IN ('final', 'settled', 'cancelled')
      AND e.commence_at <= ?
    ORDER BY e.commence_at ASC
  `).all(horizon)
}

/** How long the final flush may take before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 5_000

export default function (cli: CLI) {
  cli
    .command('odds:watch', 'Run the realtime odds loop')
    .option('--once', 'Run a single pass and exit', { default: false })
    .option('--tick <ms>', 'How often to check what is due', { default: 250 })
    .action(async (options: { once?: boolean, tick?: number }) => {
      const db = new Database()
      const adapters = activeAdapters()

      // A loop with no adapters cannot poll anything. Saying so and
      // exiting is better than idling forever while the board goes stale
      // and nothing explains why.
      //
      // `process.exitCode` rather than `process.exit()`: the latter tears
      // the process down before the logger flushes, so the operator gets a
      // bare exit code and no explanation — which is precisely the failure
      // this branch exists to prevent.
      const fallbackAvailable = Boolean(process.env.ODDS_API_KEY)
      if (adapters.length === 0 && !fallbackAvailable) {
        log.error('No book adapters are active, so there is nothing to poll.')

        const missing = booksWithoutAdapters()
        if (missing.length > 0)
          log.info(`Books enabled in config/odds.ts with no adapter written yet: ${missing.join(', ')}`)

        process.exitCode = ExitCode.FatalError
        return
      }

      const sports = await pollableSports(db)

      // This process resolves the same games all day; remember their ids.
      enableIdentityMemo()

      // Streamed prices, coalesced per game and written every two seconds
      // through the same writer polling uses, so a pushed price and a
      // polled one are stored, de-duplicated and snapshotted identically.
      //
      // A few games per transaction: Vitess aborts any transaction open past
      // thirty seconds, and a flush right after startup, before any id is
      // remembered, can carry every game on the slate.
      const pushes = new PushBuffer(async (pushed) => {
        const changed = await writePushed(db, pushed)
        if (changed > 0)
          log.debug(`[odds] stream: ${changed} price${changed === 1 ? '' : 's'} moved across ${pushed.length} game${pushed.length === 1 ? '' : 's'}`)
      })

      const engine = new OddsEngine({
        db,
        adapters,
        sports,
        contextFor: (adapter, tracker) => bookContextFor(adapter, tracker),
        loadEvents: () => loadScheduledEvents(db),
        fallbackAvailable,
        tickMs: Number(options.tick) || 250,
        // A socket's discovery reads need a tracker to count against; it
        // is never opened as a run row, since the stream has no "pass".
        trackerFor: adapter => new IngestRunTracker(db, `${adapter.slug}-stream`, 'odds'),
        onPush: (book, event) => pushes.add(book, event),
        onChange: ({ sports: polled, changed }) => {
          log.info(`${changed} price${changed === 1 ? '' : 's'} moved across ${polled.join(', ')}`)
        },
      })

      await engine.refreshSchedule()

      if (options.once) {
        const result = await engine.runOnce()
        log.info(`Polled ${result.polled.join(', ') || 'nothing'} — ${result.changed} changed`)
        for (const error of result.errors)
          log.warn(error)
        return
      }

      const active = engine.snapshot().filter(schedule => schedule.intervalMs > 0)
      log.success(`Watching ${active.length} league${active.length === 1 ? '' : 's'} across ${adapters.length} book${adapters.length === 1 ? '' : 's'}`)
      for (const schedule of active)
        log.info(`  ${schedule.slug} every ${schedule.intervalMs}ms`)

      // Sockets before polls. A book that pushes takes its leagues off the
      // polling path from its first message, so opening them first avoids
      // one redundant pass per pushing book at startup.
      engine.startSubscriptions()
      engine.start()
      pushes.start()

      // The board changes shape constantly — games start, games finish —
      // so the schedule has to be recomputed. Every thirty seconds is far
      // more often than a bucket boundary actually moves, and cheap.
      const refresh = setInterval(() => {
        void engine.refreshSchedule()
      }, 30_000)

      // Tells the scheduler its own odds passes would only repeat this one.
      beat()
      const heartbeat = setInterval(beat, BEAT_MS)

      let stopping = false
      const shutdown = () => {
        if (stopping)
          return
        stopping = true
        clearInterval(refresh)
        clearInterval(heartbeat)
        clearBeat()
        // `stop` closes the sockets too; a half-shut process holding a
        // socket open is how a supervisor restart ends up with two.
        engine.stop()
        // The last flush gets a few seconds, not systemd's whole stop
        // timeout. Pushed prices are seconds old and the next process
        // resubscribes at once, while a flush stuck behind the database held
        // every deploy for up to ninety seconds before systemd killed it.
        const exit = () => {
          log.info('Odds loop stopped.')
          process.exit(0)
        }
        setTimeout(exit, SHUTDOWN_GRACE_MS).unref()
        void pushes.stop().catch(() => {}).finally(exit)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
