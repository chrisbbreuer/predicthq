import type { Database } from '../../Support/db'
import type { KalshiComboCollection } from '../prediction-markets/kalshi-public'
import type { KalshiComboLeg } from './kalshi-trading'
import type { Suggestion } from './suggestions'
import { resolveEntitlements } from '../billing/entitlements'
import { cached, kalshiComboCollections, kalshiMarkets } from '../prediction-markets/kalshi-public'
import { jurisdictionObjection } from './eligibility'
import { clientFor, liveAccessReason } from './execute'
import { haltState } from './halt'
import { KalshiTradingClient } from './kalshi-trading'
import { suggestionPrices } from './suggestion-prices'
import { VenueError } from './venue'

export class SuggestionPreparationError extends Error {}

export async function suggestionPurchaseReason(db: Database, userId: number): Promise<string> {
  const [halt, entitlement] = await Promise.all([haltState(db), resolveEntitlements(db, userId)])
  if (halt.halted)
    return 'In-app buying is disabled in production. You can prepare a ticket for review on Kalshi.'
  if (!entitlement.canAutoExecute || liveAccessReason(userId))
    return 'In-app buying is unavailable for your account. You can prepare a ticket for review on Kalshi.'
  return 'You can prepare an exact ticket here and confirm the purchase on Kalshi.'
}

function comboFits(collection: KalshiComboCollection, legs: KalshiComboLeg[]): boolean {
  if (legs.length < collection.size_min || (collection.size_max > 0 && legs.length > collection.size_max))
    return false
  const events = new Map(collection.associated_events.map(event => [event.ticker, event]))
  return legs.every((leg) => {
    const event = events.get(leg.event_ticker)
    if (!event || (leg.side === 'no' && (event.is_yes_only || collection.is_all_yes)))
      return false
    const eventCount = legs.filter(other => other.event_ticker === leg.event_ticker).length
    return (!collection.is_single_market_per_event || eventCount === 1) && (!event.size_max || eventCount <= event.size_max)
  })
}

function comboSignature(legs: KalshiComboLeg[]): string {
  return legs.map(leg => `${leg.event_ticker}:${leg.market_ticker}:${leg.side}`).sort().join('|')
}

export async function prepareExactCombo(
  legs: KalshiComboLeg[],
  collections: KalshiComboCollection[],
  prepare: KalshiTradingClient['prepareCombo'],
): Promise<string> {
  const signature = comboSignature(legs)
  for (const collection of collections.filter(candidate => comboFits(candidate, legs))) {
    try {
      const { ticker, market } = await prepare(collection.collection_ticker, legs)
      const actual = market.legs.map(leg => ({ event_ticker: leg.eventTicker, market_ticker: leg.marketTicker, side: leg.side }))
      if (!/^KXMVE[A-Z0-9-]+$/.test(ticker) || market.ticker !== ticker || comboSignature(actual) !== signature)
        throw new SuggestionPreparationError('Kalshi returned a ticket with different legs.')
      return ticker
    }
    catch (error) {
      if (!(error instanceof VenueError) || error.status !== 400)
        throw error
    }
  }
  throw new SuggestionPreparationError('Kalshi does not offer these exact legs together.')
}

export async function prepareSuggestionOnKalshi(db: Database, userId: number, ticket: Suggestion): Promise<{ url: string, stake: number }> {
  const markets = await kalshiMarkets(ticket.legs.map(leg => leg.ticker), 0)
  const quote = (await suggestionPrices([ticket], async () => markets))[ticket.id]
  if (!quote || quote.flag === 'missing')
    throw new SuggestionPreparationError('A leg is closed or its current quote is unavailable.')
  if (quote.flag === 'confidence')
    throw new SuggestionPreparationError('At least one leg fell below the 70% cutoff.')

  const legs = ticket.legs.map((leg) => {
    const event = markets.get(leg.ticker)?.eventTicker
    if (!event || !/^[A-Z0-9-]+$/.test(event))
      throw new SuggestionPreparationError('Kalshi did not identify the underlying event.')
    return { event_ticker: event, market_ticker: leg.ticker, side: leg.side }
  })

  if (ticket.kind === 'single') {
    const leg = legs[0]!
    const series = leg.event_ticker.split('-')[0]!
    const url = new URL(`https://kalshi.com/markets/${series.toLowerCase()}/event/${leg.event_ticker.toLowerCase()}`)
    url.search = new URLSearchParams({ op_market_ticker: leg.market_ticker, op_order_side: leg.side, op_order_type: 'dollars', op_side: 'buy' }).toString()
    return { url: url.href, stake: ticket.stake }
  }

  const account = await db.query<{ credentials: string, status: string, jurisdiction: string }>(`
    SELECT credentials, status, jurisdiction FROM exchange_accounts WHERE user_id = ? AND venue = 'kalshi'
  `).get(userId)
  if (!account || account.status !== 'active')
    throw new SuggestionPreparationError('Connect an active Kalshi account to prepare a combo.')
  if (jurisdictionObjection('kalshi', account.jurisdiction))
    throw new SuggestionPreparationError('Set your trading jurisdiction in Account before preparing combos.')

  const ticker = await cached(`prepare-combo:${userId}:${comboSignature(legs)}`, 60_000, async () => {
    const client = await clientFor(account.credentials)
    if (!(client instanceof KalshiTradingClient))
      throw new SuggestionPreparationError('Reconnect your Kalshi account to prepare combos.')
    const collections = await kalshiComboCollections(legs[0]!.event_ticker)
    return await prepareExactCombo(legs, collections, client.prepareCombo.bind(client))
  })
  const url = new URL('https://kalshi.com/combos')
  url.searchParams.set('marketTicker', ticker)
  return { url: url.href, stake: ticket.stake }
}
