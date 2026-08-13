import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

interface Row {
  id: number
  kind: string
  leagues: string
  venue: string
  min_value: number
  channels: string
  active: number
  last_sent_at: string | null
}

/**
 * GET /api/alerts/subscriptions — what this user has asked to be told.
 *
 * `lastSentAt` is returned because the first question about an alert
 * that never arrived is whether anything was ever sent, and a
 * subscription that cannot answer it sends the user to support instead
 * of to their spam folder.
 */
export default {
  name: 'ListSubscriptions',
  description: 'The signed-in user\'s alert subscriptions.',

  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage alerts.', 401)

    const db = new Database()

    try {
      const rows = await db.prepare<Row>(`
        SELECT id, kind, leagues, venue, min_value, channels, active, last_sent_at
        FROM alert_subscriptions
        WHERE user_id = ?
        ORDER BY id
      `).all(userId)

      return {
        count: rows.length,
        subscriptions: rows.map(row => ({
          id: row.id,
          kind: row.kind,
          leagues: row.leagues ? row.leagues.split(',').map(l => l.trim()).filter(Boolean) : [],
          venue: row.venue || 'both',
          minValue: row.min_value,
          channels: (row.channels || 'database').split(',').map(c => c.trim()).filter(Boolean),
          active: row.active === 1,
          lastSentAt: row.last_sent_at || null,
        })),
      }
    }
    finally {
      db.close()
    }
  },
}
