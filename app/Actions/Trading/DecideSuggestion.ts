import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { requestBoolean } from '../../Support/request-input'
import { response } from '@stacksjs/router'
import { approveSuggestion, dismissSuggestion } from '../../Services/trading/suggestions'

/**
 * Approve a suggestion, which records it as a paper bet, or dismiss it.
 * Approval never places a real order: betting it for real is the user's own
 * step on Kalshi, linked from the card.
 */
export default {
  name: 'DecideSuggestion',
  description: 'Approve (as a paper bet) or dismiss a suggested bet.',

  async handle(request?: {
    get?: (key: string) => string | undefined
    param?: (key: string) => string | undefined
    user?: { id?: number }
  }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to decide on suggestions.', 401)
    const id = Number(request?.param?.('id') ?? 0) || 0
    if (!id)
      return response.error('A suggestion id is required.', 422)
    const approve = requestBoolean(request, 'approve', true)
    const db = new Database()
    try {
      if (approve)
        return { suggestion: await approveSuggestion(db, userId, id) }
      await dismissSuggestion(db, userId, id)
      return { id, status: 'dismissed' }
    }
    catch (error) {
      return response.error(error instanceof Error ? error.message : String(error), 409)
    }
    finally {
      db.close()
    }
  },
}
