import type { Database } from '../../Support/db'
import type { TradingClient } from './venue'
import type { VenueHistory } from './history-types'
import { clientFor } from './execute'

const REFRESH_MS = 5 * 60_000
interface Account { id: number, venue: string, credentials: string, attempted_at: string | null }

/** A database claim prevents API requests and scheduler workers importing the same account together. */
export async function syncHistory(db: Database, options: { userId?: number, now?: Date, clientFor?: (sealed: string) => Promise<TradingClient> } = {}) {
  const now = options.now || new Date()
  const stale = new Date(now.getTime() - REFRESH_MS).toISOString()
  const accounts = await db.query<Account>(`SELECT a.id, a.venue, a.credentials, h.attempted_at
    FROM exchange_accounts a LEFT JOIN exchange_histories h ON h.exchange_account_id = a.id
    WHERE a.status = 'active'${options.userId ? ' AND a.user_id = ?' : ''} ORDER BY a.id`).all(...(options.userId ? [options.userId] : []))
  const result = { synced: 0, failed: 0 }
  for (const account of accounts) {
    await db.insertOrIgnore('exchange_histories', { exchange_account_id: account.id, payload: null, last_error: '' })
    const claimed = await db.prepare(`UPDATE exchange_histories SET attempted_at = ?
      WHERE exchange_account_id = ? AND (attempted_at IS NULL OR attempted_at < ?)`).run(now.toISOString(), account.id, stale)
    if (!claimed.changes) continue
    try {
      const client = await (options.clientFor || clientFor)(account.credentials)
      if (!client.fetchHistory) throw new Error('History is not available for this exchange.')
      const history = await client.fetchHistory()
      await enrichTitles(db, account.venue, history)
      await db.prepare('UPDATE exchange_histories SET payload = ?, synced_at = ?, last_error = ? WHERE exchange_account_id = ? AND attempted_at = ?')
        .run(JSON.stringify(history), now.toISOString(), '', account.id, now.toISOString())
      result.synced++
    }
    catch {
      // Credentials and provider responses never appear in the user-visible error.
      await db.prepare('UPDATE exchange_histories SET last_error = ? WHERE exchange_account_id = ? AND attempted_at = ?')
        .run('History could not be fully refreshed. The last successful import is preserved; retry in a few minutes.', account.id, now.toISOString())
      result.failed++
    }
  }
  return result
}

async function enrichTitles(db: Database, venue: string, history: VenueHistory) {
  const ids = [...new Set([...history.bets, ...history.activity].map(row => row.marketId))]
  const titles = new Map<string, string>()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const rows = await db.query<{ external_id: string, question: string }>(`SELECT external_id, question FROM prediction_markets WHERE venue = ? AND external_id IN (${batch.map(() => '?').join(',')})`).all(venue, ...batch)
    for (const row of rows) titles.set(row.external_id, row.question)
  }
  for (const row of [...history.bets, ...history.activity]) row.title = row.title || titles.get(row.marketId) || row.marketId
}
