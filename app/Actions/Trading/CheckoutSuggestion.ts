import { response } from '@stacksjs/router'
import { comboAmountCents, comboCheckout } from '../../Services/trading/live-combo-checkout'
import { SuggestionPreparationError } from '../../Services/trading/suggestion-kalshi'
import { suggestionForReview } from '../../Services/trading/suggestions'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { requestString } from '../../Support/request-input'

export default {
  name: 'CheckoutSuggestion',
  description: 'Request a live combo quote or explicitly accept the displayed quote.',

  async handle(request?: Parameters<typeof authenticatedUserId>[0] & { param?: (key: string) => string, get?: (key: string) => unknown }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to review live checkout.', 401)
    const id = Number(request?.param?.('id'))
    if (!Number.isSafeInteger(id) || id <= 0)
      return response.error('A valid ticket ID is required.', 422)
    const operation = requestString(request, 'operation')
    const confirmation = requestString(request, 'quoteId')
    if (operation !== 'quote' && (operation !== 'buy' || !confirmation))
      return response.error('Choose whether to request or accept an exact quote.', 422)
    const amountCents = comboAmountCents(requestString(request, 'amount', '1'))
    if (amountCents === null)
      return response.error('Enter a positive dollar amount with up to two decimal places.', 422)
    const db = new Database()
    try {
      const ticket = await suggestionForReview(db, userId, id)
      if (!ticket)
        return response.error('This ticket is past its review window or unavailable.', 404)
      return await comboCheckout(db, userId, ticket, amountCents, operation === 'buy' ? confirmation : undefined)
    }
    catch (error) {
      return error instanceof SuggestionPreparationError
        ? response.error(error.message, 409)
        : response.error('Kalshi could not complete the checkout request. Check its status before trying again.', 502)
    }
    finally {
      db.close()
    }
  },
}
