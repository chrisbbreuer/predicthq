import { response } from '@stacksjs/router'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { historyForUser, historyStats } from '../../Services/trading/history'

export default {
  name: 'GetHistory',
  description: 'Private unified prediction history and lifetime account results.',
  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId) return response.error('Sign in to view your history.', 401)
    const db = new Database()
    try {
      const history = await historyForUser(db, userId)
      const mode = request?.get?.('mode') === 'paper' ? 'paper' : 'live'
      const venue = String(request?.get?.('venue') || '')
      const status = String(request?.get?.('status') || '')
      const search = String(request?.get?.('q') || '').slice(0, 120).toLowerCase()
      const page = Math.max(1, Math.min(10000, Math.trunc(Number(request?.get?.('page')) || 1)))
      const scoped = history.bets.filter(row => row.mode === mode && (!venue || row.venue === venue))
      const selected = scoped.filter(row => (!status || row.status === status) && (!search || `${row.title} ${row.marketId}`.toLowerCase().includes(search)))
      const activities = history.activity.filter(row => row.mode === mode && (!venue || row.venue === venue) && (!search || `${row.title} ${row.marketId}`.toLowerCase().includes(search)))
      return response.json({
        stats: historyStats(scoped), bets: selected.slice((page - 1) * 25, page * 25),
        activity: activities.slice((page - 1) * 25, page * 25),
        total: selected.length, activityTotal: activities.length, page, perPage: 25,
        accounts: history.accounts, notes: history.notes,
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    catch { return response.error('Your history could not be loaded. Please retry.', 503) }
    finally { db.close() }
  },
}
