import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

/**
 * DELETE /api/keys/{id} — stop a key working.
 *
 * Marked revoked rather than deleted. The usage recorded against a key is
 * the answer to "what was this doing before we turned it off", which is
 * the question asked at precisely the moment someone turns one off.
 */
export default {
  name: 'RevokeApiKey',
  description: 'Revoke one of the signed-in user\'s API keys.',

  async handle(request?: { param?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage API keys.', 401)

    const id = Number(request?.param?.('id') ?? 0) || 0
    if (!id)
      return response.error('Which key?', 422)

    const db = new Database()

    try {
      // Scoped to the owner in the update itself, so a guessed id
      // revokes nothing rather than someone else's key.
      const result = await db.prepare(
        'UPDATE api_keys SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at = \'\'',
      ).run(new Date().toISOString(), new Date().toISOString(), id, userId)

      if (result.changes === 0)
        return response.error('API key not found, or already revoked.', 404)

      return { id, revoked: true }
    }
    finally {
      db.close()
    }
  },
}
