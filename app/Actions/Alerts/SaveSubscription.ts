import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

/**
 * POST /api/alerts/subscriptions — create or update one alert rule.
 *
 * The kinds and channels are allowlists rather than free text, because
 * both are read by the delivery path and an unrecognised value there is
 * a subscription that silently never fires. Better to refuse it here,
 * where the user is present to be told.
 */

const KINDS = ['arbitrage', 'edge']
const CHANNELS = ['database', 'email']
const VENUES = ['kalshi', 'polymarket', 'both']

/** Nobody wants an alert on every market, and a floor of zero is that. */
const MIN_FLOOR = 0.25

export default {
  name: 'SaveSubscription',
  description: 'Create or update an alert subscription for the signed-in user.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage alerts.', 401)

    const kind = (request?.get?.('kind') ?? 'arbitrage').toLowerCase()
    if (!KINDS.includes(kind))
      return response.error(`Unknown alert kind: ${kind}. Choose one of ${KINDS.join(', ')}.`, 422)

    const venue = (request?.get?.('venue') ?? 'both').toLowerCase()
    if (!VENUES.includes(venue))
      return response.error(`Unknown venue: ${venue}.`, 422)

    const channels = (request?.get?.('channels') ?? 'database')
      .split(',')
      .map(channel => channel.trim().toLowerCase())
      .filter(Boolean)

    const unknown = channels.filter(channel => !CHANNELS.includes(channel))
    if (unknown.length > 0)
      return response.error(`Unknown delivery channel: ${unknown.join(', ')}.`, 422)

    if (channels.length === 0)
      return response.error('An alert with no delivery channel would never reach you.', 422)

    const minValue = Math.max(MIN_FLOOR, Number(request?.get?.('minValue') ?? 1) || MIN_FLOOR)
    const leagues = (request?.get?.('leagues') ?? '').slice(0, 300)
    const active = request?.get?.('active') !== 'false'
    const id = Number(request?.get?.('id') ?? 0) || 0

    const db = new Database()
    const now = new Date().toISOString()

    try {
      if (id) {
        const owned = await db.prepare<{ id: number }>(
          'SELECT id FROM alert_subscriptions WHERE id = ? AND user_id = ?',
        ).get(id, userId)

        if (!owned)
          return response.error('Alert subscription not found.', 404)

        await db.prepare(`
          UPDATE alert_subscriptions
          SET kind = ?, leagues = ?, venue = ?, min_value = ?, channels = ?, active = ?, updated_at = ?
          WHERE id = ?
        `).run(kind, leagues, venue, minValue, channels.join(','), active ? 1 : 0, now, id)

        return { id, kind, leagues, venue, minValue, channels, active }
      }

      const insert = await db.prepare(`
        INSERT INTO alert_subscriptions (
          user_id, kind, leagues, venue, min_value, channels, active, last_sent_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      `).run(userId, kind, leagues, venue, minValue, channels.join(','), active ? 1 : 0, now, now)

      return { id: Number(insert.lastInsertRowid), kind, leagues, venue, minValue, channels, active }
    }
    finally {
      db.close()
    }
  },
}
