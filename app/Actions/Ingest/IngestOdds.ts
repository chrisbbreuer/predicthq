import { ingestOdds } from '../../Services/ingest/odds'
import { watcherLive } from '../../Services/odds/watcher-heartbeat'
import { openWrite } from '../../Support/db'

/**
 * Pull the latest prices, persist them with history, and record the pass.
 *
 * Replaces the old `Actions/Odds/IngestOdds`, which wrote prices with a
 * bare `UPDATE` — meaning a book quoting a selection for the first time
 * matched no row and was silently discarded, so coverage could only ever
 * shrink. The write path now upserts through
 * `app/Services/ingest/prices.ts`.
 */
export default {
  name: 'IngestOdds',
  description: 'Fetch the latest odds, persist them with history, and broadcast.',

  async handle() {
    // `odds:watch` is already polling every book on a cadence of seconds.
    if (watcherLive())
      return { skipped: 'odds:watch is running' as const }

    const db = openWrite()
    try {
      return await ingestOdds(db)
    }
    finally {
      db.close()
    }
  },
}
