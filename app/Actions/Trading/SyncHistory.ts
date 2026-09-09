import { response } from '@stacksjs/router'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { syncHistory } from '../../Services/trading/history-sync'

export default {
  name: 'SyncHistory',
  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId) return response.error('Sign in to sync your history.', 401)
    const db = new Database()
    try { return response.json(await syncHistory(db, { userId }), { headers: { 'Cache-Control': 'private, no-store' } }) }
    catch { return response.error('History sync could not complete. Please retry.', 503) }
    finally { db.close() }
  },
}
