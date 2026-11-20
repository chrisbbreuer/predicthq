import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { buyableCombos, isLiveComboCandidate } from '../../Services/trading/live-combo-checkout'
import { LIVE_COMBO_PAYOUT_FLOOR, suggestionCheckoutReason } from '../../Services/trading/suggestion-kalshi'
import { suggestionMatchups } from '../../Services/trading/suggestion-matchups'
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
      const purchaseReason = await suggestionCheckoutReason(db, userId)
      const candidates = purchaseReason ? [] : [...(slate?.alternatives ?? []), ...suggestions.pending].filter(ticket => isLiveComboCandidate(ticket))
      const prices = await suggestionPrices(candidates.map(ticket => ({ ...ticket, minReturnMultiple: LIVE_COMBO_PAYOUT_FLOOR })))
      const live = await buyableCombos(db, candidates, prices)
      const matchups = await suggestionMatchups(live)
      return { slate, live, prices, matchups, purchaseReason }
    }
    finally {
      db.close()
    }
  },
}
