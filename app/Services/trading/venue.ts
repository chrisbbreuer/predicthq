/**
 * The contract every tradable venue implements.
 *
 * Kalshi and Polymarket disagree about almost everything at the wire —
 * auth scheme, price units, what an "order" is — so the executor talks
 * to this instead. Prices are probabilities in 0..1 everywhere on this
 * side of the boundary; the cent and six-decimal conventions the venues
 * use stay inside their own clients.
 */

export type Venue = 'kalshi' | 'polymarket'

export interface PlaceOrderRequest {
  /** Venue market identifier (Kalshi ticker, Polymarket token id). */
  marketExternalId: string
  /** Side to buy: 'yes' | 'no' for Kalshi, an outcome label elsewhere. */
  side: string
  /** Highest probability price we will pay, 0..1. */
  limitPrice: number
  /** Contracts. */
  size: number
  /** Our id, replayed on retry so the venue can collapse duplicates. */
  clientOrderId: string
}

export interface PlaceOrderResult {
  externalOrderId: string
  /** 'open' | 'filled' | 'partial' | 'cancelled' */
  status: string
  filledSize: number
  avgFillPrice: number
}

export interface VenueBalance {
  /** Settled cash available to trade, in USD. */
  available: number
}

export interface VenuePosition {
  marketExternalId: string
  side: string
  size: number
  avgPrice: number
}

/**
 * An order the venue says is still working, whoever placed it.
 *
 * Distinct from `PlaceOrderResult`, which answers "what became of the
 * order I sent" and is keyed by an order we already know about. This
 * answers "what is resting on this account", including the orders a user
 * placed in the venue's own app, which we have no other way to learn.
 */
export interface VenueOrder {
  externalOrderId: string
  marketExternalId: string
  side: string
  limitPrice: number
  /** Contracts the order was for. */
  size: number
  /** Contracts still unfilled — what the order actually commits. */
  remainingSize: number
  /** Venue timestamp, ISO 8601, or '' when it does not report one. */
  placedAt: string
}

export interface TradingClient {
  readonly venue: Venue
  /** Whether replaying placeOrder after an unknown response is venue-idempotent. */
  readonly supportsIdempotentReplay?: boolean
  /** Reads the balance. Doubles as the credential health check. */
  fetchBalance: () => Promise<VenueBalance>
  fetchPositions: () => Promise<VenuePosition[]>
  /**
   * Everything resting on the account. Optional: a venue whose API
   * cannot list orders it was not asked about simply omits it, and the
   * account sync reports no resting orders rather than pretending there
   * are none.
   */
  fetchOpenOrders?: () => Promise<VenueOrder[]>
  placeOrder: (request: PlaceOrderRequest) => Promise<PlaceOrderResult>
  fetchOrder: (externalOrderId: string) => Promise<PlaceOrderResult | null>
  cancelOrder: (externalOrderId: string) => Promise<boolean>
}

/**
 * A venue said no.
 *
 * `retryable` separates "the network blinked" from "these credentials are
 * wrong" — the executor retries the first and revokes the account on the
 * second, and getting that backwards either hammers a venue that is
 * rejecting us or gives up on a transient blip.
 */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly venue: Venue,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'VenueError'
  }
}

/**
 * Classify an HTTP status the way the executor needs it.
 *
 * 429 and 5xx are the venue's problem and pass. 401/403 mean the
 * credentials are dead. Everything else in the 4xx range is our request
 * being wrong, which retrying cannot fix.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** True when a rejection means the credentials themselves are no good. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}
