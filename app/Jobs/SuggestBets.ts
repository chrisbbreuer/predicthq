import { Job } from '@stacksjs/queue'
import { Database } from '../Support/db'
import { monitored } from '../Services/monitoring'
import { liveLines } from '../Services/trading/line-snapshots'
import { propLines } from '../Services/trading/props'
import { generateSuggestions } from '../Services/trading/suggestions'

/**
 * Refresh bet suggestions every ten minutes for every account with a
 * trading strategy: pre-game picks against the book, and a live-leg parlay
 * while games are under way. The lines are read once and shared.
 */
export default new Job({
  name: 'SuggestBets',
  description: 'Suggest singles and parlays for each account to approve',
  queue: 'default',
  tries: 1,
  backoff: 3,
  handle: monitored('SuggestBets', async () => {
    const db = new Database()
    try {
      const users = await db.query<{ user_id: number | string }>(`SELECT DISTINCT user_id FROM trading_strategies WHERE user_id IS NOT NULL`).all()
      if (users.length === 0)
        return { users: 0, saved: 0 }
      const lines = await liveLines(undefined, 18 * 60, { includeLive: true })
      const props = await propLines()
      let saved = 0
      for (const { user_id } of users)
        saved += await generateSuggestions(db, Number(user_id), { lines, props })
      return { users: users.length, saved }
    }
    finally {
      db.close()
    }
  }),
})
