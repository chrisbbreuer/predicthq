import type { Database } from '../../Support/db'
import type { KalshiRfqQuote } from './kalshi-trading'
import type { SuggestionQuote } from './suggestion-prices'
import type { Suggestion } from './suggestions'
import { createHash, randomUUID } from 'node:crypto'
import { kalshiComboCollections } from '../prediction-markets/kalshi-public'
import { clientFor } from './execute'
import { KalshiTradingClient } from './kalshi-trading'
import { comboFits, kalshiCheckoutAccount, LIVE_COMBO_PAYOUT_FLOOR, prepareExactCombo, suggestionCheckoutReason, suggestionLegs, SuggestionPreparationError } from './suggestion-kalshi'

interface Offer { id: string, price: number, payout: number, maxCost: number, expires: number }
interface Checkout {
  nonce: string
  credentials: string
  phase: 'opening' | 'open' | 'submitting' | 'submitted'
  expires: number
  market?: string
  rfq?: string
  offer?: Offer
}

const lifetime = 90_000
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

/** A target-cost YES purchase accepts the maker's NO bid. The venue caps fees and principal at the target. */
export function qualifyingComboOffer(quote: KalshiRfqQuote, rfq: string, market: string, stake: number, multiple: number, expires: number): Offer | null {
  const bid = Number(quote.no_bid_dollars)
  const payout = Number(quote.no_contracts_fp)
  const price = Math.round((1 - bid) * 10_000) / 10_000
  if (!uuid.test(quote.id) || quote.rfq_id !== rfq || quote.market_ticker !== market || quote.status !== 'open'
    || !(bid > 0 && bid < 1) || !Number.isFinite(payout) || payout < stake * multiple
    || payout * price > stake + 0.000001 || quote.target_cost_excludes_fees === true
    || (quote.rfq_target_cost_dollars !== undefined && Number(quote.rfq_target_cost_dollars) !== stake))
    return null
  return { id: quote.id, price, payout, maxCost: stake, expires }
}

async function checkoutAccount(db: Database, userId: number) {
  const reason = await suggestionCheckoutReason(db, userId)
  if (reason)
    throw new SuggestionPreparationError(reason)
  const account = await kalshiCheckoutAccount(db, userId)
  if (!account)
    throw new SuggestionPreparationError('Connect an eligible, active Kalshi account to buy a combo.')
  const client = await clientFor(account.credentials)
  if (!(client instanceof KalshiTradingClient))
    throw new SuggestionPreparationError('Reconnect your Kalshi account to request a quote.')
  return { client, credentials: createHash('sha256').update(account.credentials).digest('hex') }
}

export function isLiveComboCandidate(ticket: Suggestion, now = Date.now()): boolean {
  return ticket.kind === 'parlay' && Number(ticket.stake) === 1 && ticket.legs.length >= 2
    && (ticket.status === 'pending' || ticket.status === 'approved') && Date.parse(ticket.expiresAt) > now
}

export async function buyableCombos(
  db: Database,
  tickets: Suggestion[],
  prices: Record<number, SuggestionQuote>,
  collections = kalshiComboCollections,
  now = Date.now(),
): Promise<Suggestion[]> {
  const eligible = tickets.filter(ticket => isLiveComboCandidate(ticket, now) && prices[ticket.id]?.flag === null)
  if (!eligible.length)
    return []
  const rows = await db.query<{ bet_suggestion_id: number, payload: string }>(`
    SELECT bet_suggestion_id, payload FROM suggestion_checkouts
    WHERE bet_suggestion_id IN (${eligible.map(() => '?').join(',')})
  `).all(...eligible.map(ticket => ticket.id))
  const submitted = new Set(rows.filter(row => {
    const phase = (JSON.parse(row.payload) as Checkout).phase
    return phase === 'submitted' || phase === 'submitting'
  }).map(row => Number(row.bet_suggestion_id)))
  const available = await Promise.all(eligible.map(async (ticket) => {
    if (submitted.has(ticket.id))
      return null
    const legs = ticket.legs.map((leg, index) => ({ event_ticker: prices[ticket.id]!.legs[index]?.eventTicker ?? '', market_ticker: leg.ticker, side: leg.side }))
    if (legs.some(leg => !leg.event_ticker))
      return null
    const allowed = await collections(legs[0]!.event_ticker).catch(() => [])
    return allowed.some(collection => comboFits(collection, legs)) ? ticket : null
  }))
  return available.filter(ticket => ticket !== null)
}

async function load(db: Database, id: number) {
  const row = await db.query<{ payload: string }>('SELECT payload FROM suggestion_checkouts WHERE bet_suggestion_id = ?').get(id)
  return row ? { raw: row.payload, intent: JSON.parse(row.payload) as Checkout } : null
}

async function claim(db: Database, id: number, intent: Checkout, previous?: string): Promise<string> {
  const raw = JSON.stringify(intent)
  const now = new Date().toISOString()
  if (previous) {
    await db.query('UPDATE suggestion_checkouts SET payload = ?, updated_at = ? WHERE bet_suggestion_id = ? AND payload = ?').run(raw, now, id, previous)
  }
  else {
    await db.insertOrIgnore('suggestion_checkouts', { bet_suggestion_id: id, payload: raw, created_at: now, updated_at: now })
  }
  if ((await load(db, id))?.raw !== raw)
    throw new SuggestionPreparationError('This ticket is being updated. Refresh its checkout status.')
  return raw
}

async function status(client: KalshiTradingClient, intent: Checkout) {
  const quotes = intent.rfq ? await client.comboQuotes(intent.rfq).catch(() => []) : []
  const executed = quotes.find(quote => quote.market_ticker === intent.market && quote.executed_ts && quote.rfq_creator_order_id)
  if (executed)
    return { state: 'executed', orderId: executed.rfq_creator_order_id } as const
  return { state: 'submitted' } as const
}

export async function comboCheckout(db: Database, userId: number, ticket: Suggestion, confirmation?: string) {
  // The private rollout uses the $1 suggested tickets the account requested.
  if (ticket.kind !== 'parlay' || Number(ticket.stake) !== 1)
    throw new SuggestionPreparationError('Live combo checkout is available for $1 parlays.')
  const { client, credentials } = await checkoutAccount(db, userId)
  const previous = await load(db, ticket.id)
  let intent = previous?.intent
  let raw = previous?.raw
  if (intent && intent.credentials !== credentials)
    throw new SuggestionPreparationError('This checkout was started with a different Kalshi connection.')
  if (intent?.phase === 'submitting' || intent?.phase === 'submitted')
    return status(client, intent)

  const multiple = LIVE_COMBO_PAYOUT_FLOOR
  if (confirmation) {
    if (intent?.phase !== 'open' || !intent.rfq || !intent.market || !raw || intent.offer?.id !== confirmation || intent.offer.expires <= Date.now())
      throw new SuggestionPreparationError('This quote has expired. Refresh the quote before buying.')
    const [quotes] = await Promise.all([client.comboQuotes(intent.rfq), suggestionLegs(ticket, true)])
    const quote = quotes.find(row => row.id === confirmation)
    const current = quote && qualifyingComboOffer(quote, intent.rfq, intent.market, 1, multiple, intent.offer.expires)
    if (!current || current.price !== intent.offer.price || current.payout !== intent.offer.payout || current.expires <= Date.now())
      throw new SuggestionPreparationError('Kalshi changed the quote. Review the updated payout before buying.')
    // The unique ticket row plus a fresh claim token prevents duplicate sends across workers.
    const sending: Checkout = { ...intent, phase: 'submitting', nonce: randomUUID() }
    const claimed = await claim(db, ticket.id, sending, raw)
    if (await suggestionCheckoutReason(db, userId))
      throw new SuggestionPreparationError('Live checkout was paused before this order could be sent.')
    try {
      await client.acceptComboQuote(intent.rfq, confirmation)
    }
    catch {
      // An interrupted write may have reached the exchange. Subsequent calls reconcile only.
      return status(client, sending)
    }
    await claim(db, ticket.id, { ...sending, phase: 'submitted' }, claimed)
    return status(client, sending)
  }

  if (intent?.phase === 'opening' && intent.expires > Date.now())
    return { state: 'waiting' } as const
  if (!intent || intent.phase === 'opening' || intent.expires <= Date.now()) {
    const oldRfq = intent?.rfq
    const opening: Checkout = { nonce: randomUUID(), phase: 'opening', credentials, expires: Date.now() + lifetime }
    const opened = await claim(db, ticket.id, opening, raw)
    if (oldRfq)
      await client.closeComboRfq(oldRfq)
    const legs = await suggestionLegs(ticket, true)
    const collections = await kalshiComboCollections(legs[0]!.event_ticker)
    const market = await prepareExactCombo(legs, collections, client.prepareCombo.bind(client))
    const rfq = await client.createComboRfq(market, 1)
    if (!uuid.test(rfq))
      throw new SuggestionPreparationError('Kalshi did not return a usable quote request.')
    intent = { ...opening, phase: 'open', market, rfq, expires: Date.now() + lifetime }
    raw = await claim(db, ticket.id, intent, opened)
  }
  if (!intent.rfq || !intent.market)
    throw new SuggestionPreparationError('The quote request is unavailable.')
  for (let attempt = 0; attempt < 4; attempt++) {
    const quotes = await client.comboQuotes(intent.rfq)
    const expires = Math.min(intent.expires, Date.now() + 25_000)
    const offers = quotes.map(quote => qualifyingComboOffer(quote, intent.rfq!, intent.market!, 1, multiple, expires))
      .filter(offer => offer !== null).sort((a, b) => b.payout - a.payout || a.price - b.price)
    if (offers[0]) {
      await claim(db, ticket.id, { ...intent, offer: offers[0], nonce: randomUUID() }, raw)
      return { state: 'quote', offer: offers[0] } as const
    }
    if (attempt < 3)
      await Bun.sleep(800)
  }
  return { state: 'waiting', minPayout: multiple } as const
}
