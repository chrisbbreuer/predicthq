import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { suggestionPrices } from '../../Services/trading/suggestion-prices'
import { listSuggestions } from '../../Services/trading/suggestions'

/** The bets PredictHQ suggests for the signed-in user, pending and recently decided. */
export default {
  name: 'GetSuggestions',
  description: 'Suggested singles and parlays, waiting on approval.',

  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to see suggested bets.', 401)
    const db = new Database()
    try {
      const suggestions = await listSuggestions(db, userId)
      const slate = suggestions.slate
      const prices = slate ? await suggestionPrices([...slate.tickets, ...slate.alternatives]) : {}
      return { ...suggestions, prices }
    }
    finally {
      db.close()
    }
  },
}
