import type { PolymarketUsCredentials } from './credentials'
import type { PlaceOrderResult, TradingClient, VenueBalance, VenueOrder, VenuePosition } from './venue'
import { Buffer } from 'node:buffer'
import { createPrivateKey, sign } from 'node:crypto'
import { isRetryableStatus, VenueError } from './venue'

const BASE_URL = 'https://api.polymarket.us'

/** Polymarket US uses Ed25519 API keys, independently of international wallets. */
export function polymarketUsHeaders(credentials: PolymarketUsCredentials, path: string, timestamp = Date.now()): Record<string, string> {
  const seed = Buffer.from(credentials.secretKey, 'base64').subarray(0, 32)
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  })
  const message = `${timestamp}GET${path.split('?')[0]}`
  return {
    'X-PM-Access-Key': credentials.keyId,
    'X-PM-Timestamp': String(timestamp),
    'X-PM-Signature': sign(null, Buffer.from(message), key).toString('base64'),
    'Accept': 'application/json',
  }
}

interface Amount { value: string, currency: string }
interface UsPosition { netPositionDecimal?: string, netPosition?: string, cost: Amount, expired?: boolean }
interface UsOrder {
  id: string, marketSlug: string, intent: string, price: Amount,
  quantity: number, leavesQuantity: number, createTime?: string,
}

/** Portfolio-only connection. This adapter never sends financial mutations. */
export class PolymarketUsClient implements TradingClient {
  readonly venue = 'polymarket-us' as const
  constructor(private readonly credentials: PolymarketUsCredentials, private readonly fetcher: typeof fetch = fetch) {}

  private async read<T>(path: string): Promise<T> {
    let result: Response
    try {
      result = await this.fetcher(`${BASE_URL}${path}`, {
        headers: polymarketUsHeaders(this.credentials, path),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
    }
    catch { throw new VenueError('Polymarket US could not be reached. Retry shortly.', this.venue, 503, true) }
    if (!result.ok)
      throw new VenueError(`Polymarket US request failed (${result.status}).`, this.venue, result.status, isRetryableStatus(result.status))
    return await result.json() as T
  }

  async fetchBalance(): Promise<VenueBalance> {
    const data = await this.read<{ balances: Array<{ currency: string, buyingPower: number }> }>('/v1/account/balances')
    const usd = data.balances?.find(balance => balance.currency === 'USD')
    if (!usd || !Number.isFinite(Number(usd.buyingPower)))
      throw new VenueError('Polymarket US did not return a USD buying-power balance.', this.venue, 502, true)
    return { available: Number(usd.buyingPower) }
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    const positions: VenuePosition[] = []
    const cursors = new Set<string>()
    let cursor = ''
    for (let page = 0; page < 100; page++) {
      const data = await this.read<{ positions: Record<string, UsPosition>, nextCursor?: string, eof?: boolean }>(
        `/v1/portfolio/positions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      if (!data.positions || typeof data.positions !== 'object' || Array.isArray(data.positions))
        throw new VenueError('Polymarket US returned an invalid position snapshot.', this.venue, 502, true)
      for (const [marketExternalId, position] of Object.entries(data.positions)) {
        const quantity = Number(position.netPositionDecimal ?? position.netPosition)
        if (!Number.isFinite(quantity)) throw new VenueError('Polymarket US returned an invalid position quantity.', this.venue, 502, true)
        if (!quantity || position.expired) continue
        const cost = Number(position.cost?.value)
        if (!Number.isFinite(cost) || position.cost?.currency !== 'USD')
          throw new VenueError('Polymarket US returned an invalid position cost.', this.venue, 502, true)
        positions.push({ marketExternalId, side: quantity > 0 ? 'yes' : 'no', size: Math.abs(quantity), avgPrice: Math.abs(cost / quantity) })
      }
      if (data.eof || !data.nextCursor) return positions
      if (cursors.has(data.nextCursor)) break
      cursor = data.nextCursor
      cursors.add(cursor)
    }
    throw new VenueError('Polymarket US position pagination did not complete.', this.venue, 502, true)
  }

  async fetchOpenOrders(): Promise<VenueOrder[]> {
    const data = await this.read<{ orders: UsOrder[] }>('/v1/orders/open')
    if (!Array.isArray(data.orders)) throw new VenueError('Polymarket US returned an invalid order snapshot.', this.venue, 502, true)
    return data.orders.map(order => ({
      externalOrderId: order.id, marketExternalId: order.marketSlug,
      side: order.intent?.includes('SHORT') ? 'no' : 'yes',
      limitPrice: Number(order.price.value), size: Number(order.quantity),
      remainingSize: Number(order.leavesQuantity), placedAt: order.createTime ?? '',
    }))
  }

  async placeOrder(): Promise<PlaceOrderResult> { throw this.readOnlyError() }
  async fetchOrder(): Promise<PlaceOrderResult | null> { throw this.readOnlyError() }
  async cancelOrder(): Promise<boolean> { throw this.readOnlyError() }
  private readOnlyError(): VenueError {
    return new VenueError('The Polymarket US connection supports portfolio sync only. Manage orders at Polymarket US.', this.venue, 422, false)
  }
}
