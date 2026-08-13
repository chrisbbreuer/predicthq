import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

/**
 * DELETE /api/alerts/subscriptions/{id} — stop being told.
 *
 * Deletes rather than deactivates. A user turning an alert off is asking
 * for it to be gone, and keeping the row so it can be reported back to
 * them later is a decision they did not make.
 */
export default {
  name: 'DeleteSubscription',
  description: 'Remove one of the signed-in user\'s alert subscriptions.',

  async handle(request?: { param?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage alerts.', 401)

    const id = Number(request?.param?.('id') ?? 0) || 0
    if (!id)
      return response.error('Which subscription?', 422)

    const db = new Database()

    try {
      // Scoped to the owner in the delete itself, so a guessed id
      // deletes nothing rather than someone else's alert.
      const result = await db.prepare('DELETE FROM alert_subscriptions WHERE id = ? AND user_id = ?')
        .run(id, userId)

      if (result.changes === 0)
        return response.error('Alert subscription not found.', 404)

      return { id, deleted: true }
    }
    finally {
      db.close()
    }
  },
}
