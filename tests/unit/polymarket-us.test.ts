import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { assertUsable, maskIdentifier } from '../../app/Services/trading/credentials'
import { PolymarketUsClient, polymarketUsHeaders } from '../../app/Services/trading/polymarket-us'

const credentials = { venue: 'polymarket-us' as const, keyId: 'test-key-1234', secretKey: Buffer.alloc(32, 7).toString('base64') }
const fetcher = (fn: (url: string, init?: RequestInit) => unknown): typeof fetch => (async (url, init) => Response.json(fn(String(url), init))) as typeof fetch

describe('Polymarket US portfolio connection', () => {
  it('signs the method and path with Ed25519, excluding query parameters', () => {
    const headers = polymarketUsHeaders(credentials, '/v1/portfolio/positions?limit=100', 123)
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' })
    expect(verify(null, Buffer.from('123GET/v1/portfolio/positions'), createPublicKey(key), Buffer.from(headers['X-PM-Signature']!, 'base64'))).toBe(true)
    expect(maskIdentifier(credentials)).toBe('…1234')
    expect(() => assertUsable(credentials)).not.toThrow()
    expect(() => assertUsable({ ...credentials, secretKey: 'wrong' })).toThrow()
  })
  it('verifies USD buying power, preserving zero and rejecting incomplete balances', async () => {
    expect(await new PolymarketUsClient(credentials, fetcher(() => ({ balances: [{ currency: 'USD', buyingPower: 0 }] }))).fetchBalance()).toEqual({ available: 0 })
    await expect(new PolymarketUsClient(credentials, fetcher(() => ({ balances: [] }))).fetchBalance()).rejects.toThrow('USD')
  })
  it('paginates positions and maps long and short contracts', async () => {
    const client = new PolymarketUsClient(credentials, fetcher(url => url.includes('cursor=next')
      ? { positions: { short: { netPositionDecimal: '-2', cost: { value: '0.8', currency: 'USD' } } }, eof: true }
      : { positions: { long: { netPositionDecimal: '3.5', cost: { value: '1.75', currency: 'USD' } } }, nextCursor: 'next' }))
    expect(await client.fetchPositions()).toEqual([
      { marketExternalId: 'long', side: 'yes', size: 3.5, avgPrice: 0.5 },
      { marketExternalId: 'short', side: 'no', size: 2, avgPrice: 0.4 },
    ])
  })
  it('fails incomplete pagination instead of overwriting a complete local portfolio', async () => {
    const client = new PolymarketUsClient(credentials, fetcher(() => ({ positions: {}, nextCursor: 'repeated' })))
    await expect(client.fetchPositions()).rejects.toThrow('pagination')
  })
  it('rejects order mutations without contacting the exchange', async () => {
    let calls = 0
    const client = new PolymarketUsClient(credentials, fetcher(() => { calls++; return {} }))
    await expect(client.placeOrder()).rejects.toThrow('portfolio sync only')
    await expect(client.cancelOrder()).rejects.toThrow('portfolio sync only')
    expect(calls).toBe(0)
  })
})
