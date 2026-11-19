import { response } from '@stacksjs/router'
import { prepareSuggestionOnKalshi, SuggestionPreparationError } from '../../Services/trading/suggestion-kalshi'
import { suggestionForReview } from '../../Services/trading/suggestions'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'

export default {
  name: 'PrepareSuggestion',
  description: 'Prepare the exact Kalshi market for a signed-in user to review.',

  async handle(request?: Parameters<typeof authenticatedUserId>[0] & { param?: (key: string) => string | undefined }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to prepare a ticket.', 401)
    const id = Number(request?.param?.('id'))
    if (!Number.isSafeInteger(id) || id <= 0)
      return response.error('A valid ticket ID is required.', 422)
    const db = new Database()
    try {
      const ticket = await suggestionForReview(db, userId, id)
      if (!ticket)
        return response.error('This ticket is past its review window or unavailable.', 404)
      return await prepareSuggestionOnKalshi(db, userId, ticket)
    }
    catch (error) {
      return error instanceof SuggestionPreparationError
        ? response.error(error.message, 409)
        : response.error('Kalshi could not prepare this ticket. Try again shortly.', 502)
    }
    finally {
      db.close()
    }
  },
}
