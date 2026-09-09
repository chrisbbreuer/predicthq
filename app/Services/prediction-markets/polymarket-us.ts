import { chunk, fetchJson } from './provider'

interface UsMarket {
  slug: string, question: string, title?: string, category?: string, closed?: boolean,
  endDate?: string, volume?: number, outcomePrices?: string,
  marketSides?: Array<{ long?: boolean, description?: string, price?: string, quote?: { value: number, currency: string } }>,
  tags?: Array<{ label?: string, league?: { name?: string }, sport?: { name?: string } }>,
}

/** Public market names and quotes for the independently operated US exchange. */
export async function polymarketUsMarkets(externalIds: string[]) {
  const markets = []
  for (const batch of chunk(externalIds, 6)) {
    const results = await Promise.all(batch.map(async (slug) => {
      const data = await fetchJson<{ market: UsMarket }>(`https://gateway.polymarket.us/v1/market/slug/${encodeURIComponent(slug)}`)
      const market = data?.market
      if (!market?.question || market.slug !== slug) return null
      const long = market.marketSides?.find(side => side.long)
      let value: unknown = long?.quote?.currency === 'USD' ? long.quote.value : long?.price
      if (value === undefined) {
        try { value = JSON.parse(market.outcomePrices || '[]')[0] }
        catch { value = undefined }
      }
      const price = value === undefined || value === null || value === '' ? null : Number(value)
      const lastPrice = price !== null && Number.isFinite(price) && price >= 0 && price <= 1 ? price : null
      return {
        venue: 'polymarket-us' as const, externalId: slug, question: market.question,
        outcomeLabel: long?.description || '', category: market.category || market.tags?.map(tag => tag.league?.name || tag.sport?.name || tag.label || '').filter(Boolean).join(' ').slice(0, 60) || '',
        status: market.closed ? 'closed' : 'open', result: '',
        volume: Number(market.volume) || 0, liquidity: 0, lastPrice, endsAt: market.endDate || '',
      }
    }))
    markets.push(...results.filter(result => result !== null))
  }
  return markets
}
