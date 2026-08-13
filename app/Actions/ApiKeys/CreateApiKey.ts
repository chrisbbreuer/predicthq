import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { issueKey } from '../../Services/api-keys'

/**
 * POST /api/keys — mint a key.
 *
 * The response carries the only copy of the secret that will ever exist
 * outside the caller's hands, and says so, because a user who assumes
 * they can come back for it later will close the tab.
 */

/** Enough for one per environment and one spare, not enough to farm. */
const MAX_ACTIVE_KEYS = 10

export default {
  name: 'CreateApiKey',
  description: 'Issue a new API key for the signed-in user.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage API keys.', 401)

    const db = new Database()

    try {
      const active = await db.prepare<{ n: number }>(
        'SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at = \'\'',
      ).get(userId)

      if (Number(active?.n ?? 0) >= MAX_ACTIVE_KEYS)
        return response.error(`You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`, 422)

      const name = (request?.get?.('name') ?? 'API key').slice(0, 80)
      const issued = await issueKey(db, userId, name)

      return {
        id: issued.id,
        name,
        prefix: `phq_${issued.prefix}`,
        key: issued.secret,
        notice: 'This is the only time the full key is shown. Store it now — it cannot be recovered, only replaced.',
      }
    }
    finally {
      db.close()
    }
  },
}
