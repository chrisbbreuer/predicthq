import type { PolymarketCredentials } from './credentials'
import type {
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingClient,
  VenueBalance,
  VenuePosition,
} from './venue'
import type { WalletClient } from 'viem'
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
} from '@polymarket/clob-client-v2'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { isRetryableStatus, VenueError } from './venue'

const CLOB = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com'
const DATA_API = process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com'
const GEOBLOCK = 'https://polymarket.com/api/geoblock'
const PUSD_DECIMALS = 1_000_000

type SdkOrder = {
  id: string
  status: string
  original_size: string
  size_matched: string
  price: string
}

interface PolymarketSdk {
  getBalanceAllowance: (params: { asset_type: AssetType }) => Promise<{ balance: string }>
  createAndPostOrder: (
    order: { tokenID: string, price: number, size: number, side: Side, builderCode?: string },
    options: Record<string, never>,
    type: OrderType.GTC,
  ) => Promise<{ success: boolean, errorMsg: string, orderID: string, status: string, takingAmount: string, makingAmount: string }>
  getOrder: (orderId: string) => Promise<SdkOrder>
  cancelOrder: (payload: { orderID: string }) => Promise<unknown>
}

interface GeoblockResponse {
  blocked: boolean
  country?: string
  region?: string
}

/**
 * Polymarket CLOB V2 adapter.
 *
 * Signing, market-version discovery, tick sizing, fees, and V2 order
 * serialization deliberately stay in Polymarket's maintained SDK. Those
 * details changed incompatibly at the V2 cutover and should not be forked
 * into application code again.
 */
export class PolymarketTradingClient implements TradingClient {
  readonly venue = 'polymarket' as const
  readonly supportsIdempotentReplay = false

  private readonly sdk: PolymarketSdk
  private geoblock?: { checkedAt: number, value: GeoblockResponse }

  constructor(
    private readonly credentials: PolymarketCredentials,
    sdk?: PolymarketSdk,
  ) {
    if (sdk) {
      this.sdk = sdk
      return
    }

    const account = privateKeyToAccount(credentials.privateKey as `0x${string}`)
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    }) as WalletClient

    this.sdk = new ClobClient({
      host: CLOB,
      chain: Chain.POLYGON,
      signer,
      creds: {
        key: credentials.apiKey,
        secret: credentials.apiSecret,
        passphrase: credentials.apiPassphrase,
      },
      signatureType: credentials.signatureType ?? SignatureTypeV2.POLY_PROXY,
      funderAddress: credentials.funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true,
      ...(process.env.POLYMARKET_BUILDER_CODE
        ? { builderConfig: { builderCode: process.env.POLYMARKET_BUILDER_CODE } }
        : {}),
    })
  }

  async fetchBalance(): Promise<VenueBalance> {
    try {
      const data = await this.sdk.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      return { available: Number(data.balance ?? 0) / PUSD_DECIMALS }
    }
    catch (error) {
      throw venueFailure('balance lookup', error)
    }
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    const url = `${DATA_API}/positions?user=${encodeURIComponent(this.credentials.funderAddress)}&sizeThreshold=0.01`
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })

    if (!response.ok) {
      throw new VenueError(
        `Polymarket positions failed (${response.status})`,
        'polymarket',
        response.status,
        isRetryableStatus(response.status),
      )
    }

    const rows = await response.json() as Array<{
      asset?: string
      outcome?: string
      size?: number
      avgPrice?: number
    }>

    return rows
      .filter(row => row.asset && (row.size ?? 0) > 0)
      .map(row => ({
        marketExternalId: row.asset!,
        side: (row.outcome ?? '').toLowerCase(),
        size: row.size ?? 0,
        avgPrice: row.avgPrice ?? 0,
      }))
  }

  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    await this.assertGeographicallyEligible()

    try {
      const data = await this.sdk.createAndPostOrder({
        tokenID: request.marketExternalId,
        price: conservativePrice(request.limitPrice),
        size: request.size,
        side: Side.BUY,
        ...(process.env.POLYMARKET_BUILDER_CODE
          ? { builderCode: process.env.POLYMARKET_BUILDER_CODE }
          : {}),
      }, {}, OrderType.GTC)

      if (!data.success) {
        throw new VenueError(
          `Polymarket rejected the order: ${data.errorMsg || 'no reason given'}`,
          'polymarket',
          400,
          false,
        )
      }

      const filledSize = Number(data.takingAmount ?? 0) / PUSD_DECIMALS
      const filledCost = Number(data.makingAmount ?? 0) / PUSD_DECIMALS

      return {
        externalOrderId: data.orderID,
        status: normalizeStatus(data.status, filledSize, request.size),
        filledSize,
        avgFillPrice: filledSize > 0 ? filledCost / filledSize : 0,
      }
    }
    catch (error) {
      if (error instanceof VenueError)
        throw error
      throw venueFailure('order placement', error)
    }
  }

  async fetchOrder(externalOrderId: string): Promise<PlaceOrderResult | null> {
    try {
      const data = await this.sdk.getOrder(externalOrderId)
      const filledSize = Number(data.size_matched ?? 0)
      return {
        externalOrderId: data.id || externalOrderId,
        status: normalizeStatus(data.status, filledSize, Number(data.original_size ?? filledSize)),
        filledSize,
        avgFillPrice: Number(data.price ?? 0),
      }
    }
    catch (error) {
      const status = statusFrom(error)
      if (status === 404)
        return null
      throw venueFailure('order lookup', error)
    }
  }

  async cancelOrder(externalOrderId: string): Promise<boolean> {
    try {
      await this.sdk.cancelOrder({ orderID: externalOrderId })
      return true
    }
    catch (error) {
      if (statusFrom(error) === 404)
        return true
      if (isRetryableStatus(statusFrom(error)))
        return false
      throw venueFailure('order cancellation', error)
    }
  }

  private async assertGeographicallyEligible(): Promise<void> {
    if (!this.geoblock || Date.now() - this.geoblock.checkedAt > 300_000) {
      const response = await fetch(GEOBLOCK, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) {
        throw new VenueError(
          `Polymarket eligibility check failed (${response.status})`,
          'polymarket',
          response.status,
          isRetryableStatus(response.status),
        )
      }
      this.geoblock = {
        checkedAt: Date.now(),
        value: await response.json() as GeoblockResponse,
      }
    }

    if (this.geoblock.value.blocked) {
      const location = [this.geoblock.value.country, this.geoblock.value.region].filter(Boolean).join('-')
      throw new VenueError(
        `Polymarket trading is unavailable from ${location || 'this location'}.`,
        'polymarket',
        451,
        false,
      )
    }
  }
}

/** Keep floating point noise from ever raising the authorized buy limit. */
export function conservativePrice(price: number): number {
  return Math.max(0.0001, Math.min(0.9999, Math.floor(price * 10_000 + Number.EPSILON) / 10_000))
}

function statusFrom(error: unknown): number {
  if (!error || typeof error !== 'object')
    return 500
  const candidate = error as { status?: number, response?: { status?: number } }
  return candidate.status ?? candidate.response?.status ?? 500
}

function venueFailure(operation: string, error: unknown): VenueError {
  const status = statusFrom(error)
  const message = error instanceof Error ? error.message : String(error)
  return new VenueError(
    `Polymarket ${operation} failed (${status}): ${message.slice(0, 300)}`,
    'polymarket',
    status,
    isRetryableStatus(status),
  )
}

function normalizeStatus(status: string | undefined, filled: number, requested: number): string {
  if (requested > 0 && filled >= requested)
    return 'filled'
  if (status === 'canceled' || status === 'cancelled')
    return filled > 0 ? 'partial' : 'cancelled'
  if (filled > 0)
    return 'partial'
  return 'open'
}
