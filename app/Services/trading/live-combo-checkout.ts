import type { Database } from '../../Support/db'
import type { KalshiRfqQuote } from './kalshi-trading'
import type { SuggestionQuote } from './suggestion-prices'
import type { Suggestion } from './suggestions'
import { createHash, randomUUID } from 'node:crypto'
import { kalshiComboCollections } from '../prediction-markets/kalshi-public'
import { clientFor } from './execute'
import { KalshiTradingClient } from './kalshi-trading'
import { comboFits, kalshiCheckoutAccount, LIVE_COMBO_PAYOUT_FLOOR, prepareExactCombo, suggestionCheckoutReason, suggestionLegs, SuggestionPreparationError } from './suggestion-kalshi'
import { VenueError } from './venue'

interface Offer { id: string, price: number, payout: number, maxCost: number, expires: number }
type FinalStatus =
  | { state: 'executed' | 'partial', orderId: string, payout: number }
  | { state: 'not_filled', reason: string }
type CheckoutStatus = FinalStatus | { state: 'submitted' | 'unverified' } | { state: 'partial_pending', payout: number }
interface Checkout {
  nonce: string
  credentials: string
  phase: 'opening' | 'open' | 'submitting' | 'submitted'
  expires: number
  market?: string
  rfq?: string
  offer?: Offer
  amountCents?: number
  submittedAt?: string
  result?: FinalStatus
}

const lifetime = 90_000
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const defaultAmountCents = 100

/** Parse a dollar amount without silently rounding extra decimal places. */
export function comboAmountCents(value: string): number | null {
  const match = value.trim().match(/^(\d*)(?:\.(\d{0,2}))?$/)
  if (!match)
    return null
  const cents = Number(match[1] + (match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

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
  return ticket.kind === 'parlay' && Number.isFinite(ticket.stake) && ticket.stake > 0 && ticket.legs.length >= 2
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

/** A maker can accept at the same price under a different quote ID. Check the whole RFQ. */
export async function comboOrderStatus(
  client: Pick<KalshiTradingClient, 'comboQuotes' | 'comboRfqStatus' | 'fetchOrder'>,
  intent: Pick<Checkout, 'rfq' | 'market' | 'expires'>,
  now = Date.now(),
): Promise<CheckoutStatus> {
  const { rfq, market } = intent
  if (!rfq || !market)
    return { state: 'unverified' }
  const quotes = (await client.comboQuotes(rfq).catch(() => null))?.filter(quote => quote.rfq_id === rfq && quote.market_ticker === market)
  const orderId = quotes?.find(quote => quote.executed_ts && quote.rfq_creator_order_id)?.rfq_creator_order_id
  if (orderId) {
    const order = await client.fetchOrder(orderId).catch(() => null)
    if (order && order.filledSize > 0) {
      const payout = order.filledSize
      if (order.status === 'filled')
        return { state: 'executed', orderId, payout }
      if (order.venueStatus === 'canceled' || order.venueStatus === 'cancelled')
        return { state: 'partial', orderId, payout }
      return { state: 'partial_pending', payout }
    }
    if (order?.status === 'cancelled')
      return { state: 'not_filled', reason: 'Kalshi canceled the order without a fill.' }
  }
  if (now < intent.expires)
    return { state: 'submitted' }
  if (quotes?.length && !quotes.some(quote => quote.executed_ts || quote.status === 'confirmed')) {
    const rfqStatus = await client.comboRfqStatus(rfq).catch(() => '')
    if (rfqStatus === 'cancelled')
      return { state: 'not_filled', reason: 'Kalshi canceled the quote request without a fill.' }
  }
  return { state: 'unverified' }
}

function approvedAmount(intent: Checkout): number {
  return intent.offer?.maxCost ?? (intent.amountCents ?? defaultAmountCents) / 100
}

async function reconcile(db: Database, id: number, raw: string, intent: Checkout, client: KalshiTradingClient): Promise<CheckoutStatus & { maxCost: number }> {
  const maxCost = approvedAmount(intent)
  if (intent.result)
    return { ...intent.result, maxCost }
  const result = await comboOrderStatus(client, intent)
  if ((intent.phase === 'submitted' || Date.now() >= intent.expires)
    && (result.state === 'executed' || result.state === 'partial' || result.state === 'not_filled')) {
    await db.query('UPDATE suggestion_checkouts SET payload = ? WHERE bet_suggestion_id = ? AND payload = ?')
      .run(JSON.stringify({ ...intent, result }), id, raw)
  }
  return { ...result, maxCost }
}

/** Read receipts by owner even after the original suggestions have expired. */
export async function comboCheckoutReceipts(db: Database, userId: number) {
  const rows = await db.query<{ id: number, legs: string, payload: string, updated_at: string }>(`
    SELECT s.id, s.legs, c.payload, c.updated_at
    FROM suggestion_checkouts c JOIN bet_suggestions s ON s.id = c.bet_suggestion_id
    WHERE s.user_id = ? AND REPLACE(JSON_EXTRACT(c.payload, '$.phase'), '"', '') IN ('submitting', 'submitted')
    ORDER BY c.updated_at DESC, s.id DESC LIMIT 8
  `).all(userId)
  if (!rows.length)
    return []
  const attempts = rows.map(row => ({ ...row, intent: JSON.parse(row.payload) as Checkout }))
  const account = attempts.some(row => !row.intent.result) ? await kalshiCheckoutAccount(db, userId) : null
  const client = account ? await clientFor(account.credentials).catch(() => null) : null
  const credentials = account ? createHash('sha256').update(account.credentials).digest('hex') : null
  return await Promise.all(attempts.map(async (row) => {
    const result = row.intent.result ?? (client instanceof KalshiTradingClient && row.intent.credentials === credentials
      ? await reconcile(db, row.id, row.payload, row.intent, client)
      : { state: 'unverified' as const })
    const legs = JSON.parse(row.legs) as Suggestion['legs']
    return { id: Number(row.id), labels: legs.map(leg => leg.label), at: row.intent.submittedAt ?? row.updated_at, maxCost: approvedAmount(row.intent), ...result }
  }))
}

export async function comboCheckout(db: Database, userId: number, ticket: Suggestion, amountCents: number, confirmation?: string) {
  if (!isLiveComboCandidate(ticket))
    throw new SuggestionPreparationError('This parlay is unavailable for live checkout.')
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new SuggestionPreparationError('Enter a positive dollar amount with up to two decimal places.')
  const { client, credentials } = await checkoutAccount(db, userId)
  const previous = await load(db, ticket.id)
  let intent = previous?.intent
  let raw = previous?.raw
  if (intent && intent.credentials !== credentials)
    throw new SuggestionPreparationError('This checkout was started with a different Kalshi connection.')
  if (intent?.phase === 'submitting' || intent?.phase === 'submitted')
    return reconcile(db, ticket.id, raw!, intent, client)

  const stake = amountCents / 100
  const pricedTicket = { ...ticket, stake }
  const preparedAmount = intent?.amountCents ?? defaultAmountCents
  const multiple = LIVE_COMBO_PAYOUT_FLOOR
  if (confirmation) {
    if (intent?.phase !== 'open' || !intent.rfq || !intent.market || !raw || intent.offer?.id !== confirmation || intent.offer.expires <= Date.now())
      throw new SuggestionPreparationError('This quote has expired. Refresh the quote before buying.')
    if (preparedAmount !== amountCents || intent.offer.maxCost !== stake)
      throw new SuggestionPreparationError('The amount changed. Get a new quote for that amount.')
    const [quotes, balance] = await Promise.all([client.comboQuotes(intent.rfq), client.fetchBalance(), suggestionLegs(pricedTicket, true)])
    if (balance.available < stake)
      throw new SuggestionPreparationError('This amount exceeds your available Kalshi cash.')
    const quote = quotes.find(row => row.id === confirmation)
    const current = quote && qualifyingComboOffer(quote, intent.rfq, intent.market, stake, multiple, intent.offer.expires)
    if (!current || current.price !== intent.offer.price || current.payout !== intent.offer.payout || current.expires <= Date.now())
      throw new SuggestionPreparationError('Kalshi changed the quote. Review the updated payout before buying.')
    // The unique ticket row plus a fresh claim token prevents duplicate sends across workers.
    const sending: Checkout = { ...intent, phase: 'submitting', nonce: randomUUID(), submittedAt: new Date().toISOString() }
    const claimed = await claim(db, ticket.id, sending, raw)
    if (await suggestionCheckoutReason(db, userId)) {
      const result = { state: 'not_filled', reason: 'Checkout was paused before this order could be sent.' } as const
      await claim(db, ticket.id, { ...sending, result }, claimed)
      return { ...result, maxCost: stake }
    }
    try {
      await client.acceptComboQuote(intent.rfq, confirmation)
    }
    catch (error) {
      if (error instanceof VenueError && [400, 401, 403, 404, 409, 422, 429].includes(error.status)) {
        const result = { state: 'not_filled', reason: 'Kalshi declined the quote acceptance.' } as const
        await claim(db, ticket.id, { ...sending, result }, claimed)
        return { ...result, maxCost: stake }
      }
      // An interrupted write may have reached the exchange. Subsequent calls reconcile only.
      return reconcile(db, ticket.id, claimed, sending, client)
    }
    const submitted = { ...sending, phase: 'submitted' } as const
    const saved = await claim(db, ticket.id, submitted, claimed)
    return reconcile(db, ticket.id, saved, submitted, client)
  }

  if (intent?.phase === 'opening' && intent.expires > Date.now())
    return { state: 'waiting' } as const
  if (!intent || intent.phase === 'opening' || intent.expires <= Date.now() || preparedAmount !== amountCents) {
    const [balance, legs] = await Promise.all([client.fetchBalance(), suggestionLegs(pricedTicket, true)])
    if (balance.available < stake)
      throw new SuggestionPreparationError('This amount exceeds your available Kalshi cash.')
    const oldRfq = intent?.rfq
    const opening: Checkout = { nonce: randomUUID(), phase: 'opening', credentials, amountCents, expires: Date.now() + lifetime }
    const opened = await claim(db, ticket.id, opening, raw)
    if (oldRfq)
      await client.closeComboRfq(oldRfq)
    const collections = await kalshiComboCollections(legs[0]!.event_ticker)
    const market = await prepareExactCombo(legs, collections, client.prepareCombo.bind(client))
    const rfq = await client.createComboRfq(market, stake).catch(async (error) => {
      if (error instanceof VenueError && error.status === 400) {
        await claim(db, ticket.id, { ...opening, expires: 0 }, opened)
        throw new SuggestionPreparationError('Kalshi could not quote this amount. Try a different amount.')
      }
      throw error
    })
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
    const offers = quotes.map(quote => qualifyingComboOffer(quote, intent.rfq!, intent.market!, stake, multiple, expires))
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
