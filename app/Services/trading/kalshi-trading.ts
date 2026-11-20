import { kalshiHistory } from './history-kalshi'
import type { KalshiCredentials } from './credentials'
import type {
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingClient,
  VenueBalance,
  VenueOrder,
  VenuePosition,
} from './venue'
import { createSign } from 'node:crypto'
import { toMarketInfo } from '../prediction-markets/kalshi-public'
import { isAuthFailure, isRetryableStatus, isTransientAuthFailure, VenueError } from './venue'

const BASE = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'

interface KalshiOrder {
  order_id: string
  ticker?: string
  status?: string
  side?: 'yes' | 'no'
  outcome_side?: 'yes' | 'no'
  fill_count_fp?: string
  remaining_count_fp?: string
  initial_count_fp?: string
  taker_fill_cost_dollars?: string
  maker_fill_cost_dollars?: string
  yes_price_dollars?: string
  no_price_dollars?: string
  created_time?: string
}

export interface KalshiComboLeg {
  event_ticker: string
  market_ticker: string
  side: 'yes' | 'no'
}

export interface KalshiRfqQuote {
  id: string
  rfq_id: string
  market_ticker: string
  status: string
  no_bid_dollars?: string
  no_contracts_fp?: string
  rfq_target_cost_dollars?: string
  target_cost_excludes_fees?: boolean
  rfq_creator_order_id?: string
  executed_ts?: string
}

/**
 * Kalshi's authenticated trading API.
 *
 * Auth is a per-request RSA-PSS signature over
 * `${timestampMs}${METHOD}${path}` — note the path only, no host and no
 * query string, which is the detail that costs an afternoon if you get
 * it wrong. Salt length must equal the digest length (32 for SHA-256);
 * Node's default is different, so it is set explicitly.
 *
 * The current order API uses fixed-point strings. Everything above this
 * file works in probabilities, so that conversion lives here.
 */
export class KalshiTradingClient implements TradingClient {
  readonly venue = 'kalshi' as const
  readonly supportsIdempotentReplay = true

  constructor(private readonly credentials: KalshiCredentials) {}

  /**
   * The subaccount selector, or nothing when the primary account is in
   * use. `prefix` is the separator it needs where it lands — '?' when it
   * opens the query string, '&' when it joins one.
   */
  private subaccountQuery(prefix: '?' | '&' = '?'): string {
    return this.credentials.subaccount === undefined ? '' : `${prefix}subaccount=${this.credentials.subaccount}`
  }

  /**
   * The signature Kalshi expects.
   *
   * A bad clock is the most common cause of a 401 here — Kalshi rejects
   * timestamps outside a few seconds of its own — which is worth knowing
   * before suspecting the key.
   */
  private sign(method: string, path: string, timestamp: string): string {
    const signer = createSign('RSA-SHA256')
    signer.update(`${timestamp}${method}${path}`)
    signer.end()

    return signer.sign({
      key: this.credentials.privateKeyPem,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32, // digest length, per Kalshi's spec
    }, 'base64')
  }

  /**
   * One signed request, with reads retried through a rate limit.
   *
   * Kalshi answers 429 when this host's combined traffic (portfolio syncs,
   * order reconciliation, public ingestion) bunches up, which happens in
   * bursts rather than steadily. A read that waits a moment and asks again
   * almost always succeeds, so GETs retry twice, honouring `Retry-After`.
   * Writes never retry here: an order placement whose fate is unknown is
   * reconciled by its client order id, not by sending it again.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, body)
      }
      catch (error) {
        // A stale-timestamp 401 is retried too: each attempt signs afresh.
        const retryable = error instanceof VenueError
          && (error.status === 429 || (error.status === 401 && isTransientAuthFailure(error.message)))
        if (!retryable || method !== 'GET' || attempt >= 2)
          throw error
        const hinted = Number((error as VenueError & { retryAfter?: number }).retryAfter)
        const wait = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted * 1000, 3000) : 400 * 2 ** attempt + Math.random() * 250
        await new Promise(resolve => setTimeout(resolve, wait))
      }
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const timestamp = Date.now().toString()
    const signedPath = path.split('?')[0]

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'KALSHI-ACCESS-KEY': this.credentials.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': this.sign(method, `/trade-api/v2${signedPath}`, timestamp),
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })

    if (!response.ok) {
      // Kalshi returns a JSON error body; keep it verbatim rather than
      // paraphrasing, because reconciling a break needs the real text.
      const detail = await response.text().catch(() => '')
      const failure = new VenueError(
        `Kalshi ${method} ${path} failed (${response.status}): ${detail.slice(0, 300)}`,
        'kalshi',
        response.status,
        isRetryableStatus(response.status),
      )
      Object.assign(failure, { retryAfter: Number(response.headers.get('retry-after')) || undefined })
      throw failure
    }

    return (response.status === 204 ? undefined : await response.json()) as T
  }

  async createComboRfq(ticker: string, stake: number): Promise<string> {
    const result = await this.request<{ id: string }>('POST', '/communications/rfqs', {
      market_ticker: ticker, target_cost_dollars: stake.toFixed(4), target_cost_excludes_fees: false,
      rest_remainder: false, obscure_creator_id: true,
      ...(this.credentials.subaccount === undefined ? {} : { subaccount: this.credentials.subaccount }),
    })
    return result.id
  }

  async comboQuotes(rfq: string): Promise<KalshiRfqQuote[]> {
    const query = new URLSearchParams({ rfq_id: rfq, rfq_user_filter: 'self', limit: '20' })
    return (await this.request<{ quotes: KalshiRfqQuote[] }>('GET', `/communications/quotes?${query}`)).quotes
  }

  async comboRfqStatus(rfq: string): Promise<string> {
    const { rfq: result } = await this.request<{ rfq: { status: string } }>('GET', `/communications/rfqs/${encodeURIComponent(rfq)}`)
    return result.status
  }

  async acceptComboQuote(rfq: string, quote: string): Promise<void> {
    await this.request('PUT', `/communications/rfqs/${encodeURIComponent(rfq)}/quotes/${encodeURIComponent(quote)}/accept`, { accepted_side: 'no' })
  }

  async closeComboRfq(rfq: string): Promise<void> {
    try {
      await this.request('DELETE', `/communications/rfqs/${encodeURIComponent(rfq)}`)
    }
    catch (error) {
      if (!(error instanceof VenueError) || error.status !== 404)
        throw error
    }
  }

  async fetchHistory() {
    return await kalshiHistory(path => this.request('GET', path), this.credentials.subaccount ?? 0)
  }

  /** Resolve the exact contract for a combo so it can be reviewed on Kalshi. */
  async prepareCombo(collection: string, legs: KalshiComboLeg[]) {
    const data = await this.request<{ market_ticker: string, market?: { mve_selected_legs?: KalshiComboLeg[] } }>(
      'POST',
      `/multivariate_event_collections/${encodeURIComponent(collection)}`,
      { selected_markets: legs, with_market_payload: true },
    )
    const exactSides = Array.isArray(data.market?.mve_selected_legs)
      && data.market.mve_selected_legs.every(leg => leg.side === 'yes' || leg.side === 'no')
    return { ticker: data.market_ticker, market: toMarketInfo(exactSides ? data.market : undefined) }
  }

  async fetchBalance(): Promise<VenueBalance> {
    // `balance` is in cents.
    const data = await this.request<{ balance: number }>('GET', `/portfolio/balance${this.subaccountQuery()}`)
    return { available: (data.balance ?? 0) / 100 }
  }

  /**
   * Every open position on the account.
   *
   * Paged, for the same reason resting orders are: the endpoint returns a
   * hundred rows by default, and an account past that would otherwise
   * have its later positions silently vanish from the book. Asking for
   * `count_filter=position` keeps closed-out markets (zero held, some
   * realized P&L) from filling the pages.
   */
  async fetchPositions(): Promise<VenuePosition[]> {
    type Row = { ticker: string, position_fp?: string, market_exposure_dollars?: string }
    const rows: Row[] = []
    let cursor = ''
    let pages = 0
    do {
      const query = `?limit=1000&count_filter=position${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${this.subaccountQuery('&')}`
      const page = await this.request<{ market_positions?: Row[], cursor?: string }>('GET', `/portfolio/positions${query}`)
      rows.push(...(page.market_positions ?? []))
      cursor = page.cursor ?? ''
      pages++
    } while (cursor && pages < 10)

    const positions: VenuePosition[] = []
    for (const p of rows) {
      const signedPosition = Number(p.position_fp ?? 0)
      if (!signedPosition)
        continue

      // Kalshi signs the position rather than naming a side: positive is
      // long yes, negative is long no. Size is the magnitude either way.
      const size = Math.abs(signedPosition)
      positions.push({
        marketExternalId: p.ticker,
        side: signedPosition > 0 ? 'yes' : 'no',
        size,
        avgPrice: size > 0 ? Math.abs(Number(p.market_exposure_dollars ?? 0)) / size : 0,
      })
    }

    return positions
  }

  /**
   * Every order still resting on the account, ours or the user's.
   *
   * `status=resting` is Kalshi's name for a live limit order. Partially
   * filled orders are still resting, so the remaining count is read
   * rather than assumed: an order half filled commits half the capital,
   * and reporting the initial count would double-count the filled half
   * that is already a position.
   */
  async fetchOpenOrders(): Promise<VenueOrder[]> {
    const orders: VenueOrder[] = []
    let cursor = ''

    // Paged, because an account can rest more orders than one page
    // holds and a truncated list reads as "the rest were cancelled".
    do {
      const query = `?status=resting&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${this.subaccountQuery('&')}`
      const page = await this.request<{ orders?: KalshiOrder[], cursor?: string }>('GET', `/portfolio/orders${query}`)

      for (const order of page.orders ?? []) {
        if (!order.ticker)
          continue

        const side = order.outcome_side ?? order.side ?? 'yes'
        const remaining = Number(order.remaining_count_fp ?? 0)
        if (!(remaining > 0))
          continue

        orders.push({
          externalOrderId: order.order_id,
          marketExternalId: order.ticker,
          side,
          limitPrice: Number(side === 'no' ? order.no_price_dollars : order.yes_price_dollars) || 0,
          size: Number(order.initial_count_fp ?? remaining) || remaining,
          remainingSize: remaining,
          placedAt: order.created_time ?? '',
        })
      }

      cursor = page.cursor ?? ''
    } while (cursor && orders.length < 1000)

    return orders
  }

  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const buyNo = request.side === 'no'
    const data = await this.request<{
      order_id: string
      fill_count?: string
      remaining_count?: string
    }>('POST', '/portfolio/events/orders', {
      client_order_id: request.clientOrderId,
      count: fixedContracts(request.size),
      // The V2 book quotes only YES. Selling YES is buying NO at 1-price.
      side: buyNo ? 'ask' : 'bid',
      price: fixedYesPrice(request.limitPrice, buyNo),
      ticker: request.marketExternalId,
      time_in_force: 'good_till_canceled',
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
      cancel_order_on_pause: true,
      reduce_only: false,
      ...(this.credentials.subaccount === undefined ? {} : { subaccount: this.credentials.subaccount }),
    })

    const canonical = await this.fetchOrder(data.order_id)
    if (canonical)
      return canonical

    const filled = Number(data.fill_count ?? 0)
    const remaining = Number(data.remaining_count ?? 0)

    return {
      externalOrderId: data.order_id,
      status: normalizeStatus(undefined, filled, filled + remaining),
      filledSize: filled,
      avgFillPrice: filled > 0 ? request.limitPrice : 0,
    }
  }

  async fetchOrder(externalOrderId: string): Promise<(PlaceOrderResult & { venueStatus?: string }) | null> {
    try {
      const data = await this.request<{
        order: KalshiOrder
      }>('GET', `/portfolio/orders/${encodeURIComponent(externalOrderId)}`)

      const filled = Number(data.order.fill_count_fp ?? 0)
      const requested = Number(data.order.initial_count_fp ?? filled)
      const side = data.order.outcome_side ?? data.order.side ?? 'yes'
      const totalCost = Number(data.order.taker_fill_cost_dollars ?? 0)
        + Number(data.order.maker_fill_cost_dollars ?? 0)
      const quotedPrice = Number(side === 'no' ? data.order.no_price_dollars : data.order.yes_price_dollars)

      return {
        externalOrderId: data.order.order_id,
        status: normalizeStatus(data.order.status ?? '', filled, requested),
        venueStatus: data.order.status,
        filledSize: filled,
        avgFillPrice: filled > 0 ? (totalCost > 0 ? totalCost / filled : quotedPrice) : 0,
      }
    }
    catch (error) {
      // A 404 means the venue never took the order — a real answer, not a
      // failure. Anything else is still a failure worth surfacing.
      if (error instanceof VenueError && error.status === 404)
        return null
      throw error
    }
  }

  async cancelOrder(externalOrderId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/portfolio/events/orders/${encodeURIComponent(externalOrderId)}${this.subaccountQuery()}`)
      return true
    }
    catch (error) {
      // An order that is already gone is the state the caller wanted.
      if (error instanceof VenueError && error.status === 404)
        return true
      if (error instanceof VenueError && isAuthFailure(error.status))
        throw error
      return false
    }
  }
}

/** Never round a requested outcome limit in the direction that pays more. */
export function fixedYesPrice(limitPrice: number, buyNo: boolean): string {
  const clamped = Math.max(0.0001, Math.min(0.9999, limitPrice))
  const scaled = buyNo
    ? Math.ceil((1 - clamped) * 10_000 - Number.EPSILON)
    : Math.floor(clamped * 10_000 + Number.EPSILON)
  return (scaled / 10_000).toFixed(4)
}

export function fixedContracts(size: number): string {
  return Math.max(0.01, Math.floor(size * 100) / 100).toFixed(2)
}

/**
 * Kalshi's order statuses onto ours. `resting` is a live limit order,
 * which is 'open' here; a `canceled` order that filled part way is still
 * a partial fill and has to be reported as one or the position is lost.
 */
function normalizeStatus(status: string | undefined, filled: number, requested: number): string {
  if (filled >= requested && requested > 0)
    return 'filled'
  if (status === 'canceled' || status === 'cancelled')
    return filled > 0 ? 'partial' : 'cancelled'
  if (filled > 0)
    return 'partial'
  return 'open'
}
