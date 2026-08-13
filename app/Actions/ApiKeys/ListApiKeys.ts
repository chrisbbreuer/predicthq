import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { usageFor } from '../../Services/api-keys'

/**
 * GET /api/keys — the user's keys and what they have been doing.
 *
 * The secret is absent, because it is not stored. What is here is the
 * prefix, which is enough to recognise which key a client is configured
 * with, and the usage, which is the thing anyone opens this page to see.
 */
export default {
  name: 'ListApiKeys',
  description: 'The signed-in user\'s API keys and their recent usage.',

  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to manage API keys.', 401)

    const db = new Database()

    try {
      const keys = await db.prepare<{
        id: number
        name: string
        prefix: string
        last_used_at: string | null
        revoked_at: string | null
        created_at: string
      }>(`
        SELECT id, name, prefix, last_used_at, revoked_at, created_at
        FROM api_keys
        WHERE user_id = ?
        ORDER BY id
      `).all(userId)

      const out = []
      for (const key of keys) {
        const usage = await usageFor(db, key.id)

        out.push({
          id: key.id,
          name: key.name,
          // Enough to identify, never enough to use.
          prefix: `phq_${key.prefix}`,
          createdAt: key.created_at,
          lastUsedAt: key.last_used_at || null,
          revoked: Boolean(key.revoked_at),
          requestsLast30Days: usage.reduce((sum, row) => sum + Number(row.requests), 0),
          usage,
        })
      }

      return { count: out.length, keys: out }
    }
    finally {
      db.close()
    }
  },
}
