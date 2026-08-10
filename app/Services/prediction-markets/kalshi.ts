import type { PredictionMarketProvider, VenueMarket, VenueTrade } from './provider'
import { chunk, fetchJson } from './provider'

const BASE = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'

interface KalshiTrade {
  trade_id: string
  ticker: string
  count_fp: string
  yes_price_dollars: string
  no_price_dollars: string
  taker_side: string
  created_time: string
}

interface KalshiMarket {
  ticker: string
  title: string
  category?: string
  status: string
  result?: string
  volume_fp?: string
  liquidity_dollars?: string
  last_price_dollars?: string
  yes_sub_title?: string
  close_time?: string
}

/** Map Kalshi market statuses onto our three-state model. */
function normalizeStatus(status: string): string {
  if (status === 'finalized' || status === 'settled')
    return 'settled'
  if (status === 'active' || status === 'open')
    return 'open'
  return 'closed'
}

/**
 * Kalshi's public trade tape and market metadata (no auth required).
 * Fills are anonymous — Kalshi never exposes who traded — so every trade
 * is ingested without a trader identity. `taker_side` is the side the
 * aggressor bought, which is the "someone just bet on X" signal.
 */
export class KalshiProvider implements PredictionMarketProvider {
  readonly name = 'kalshi'

  async fetchTrades(limit: number): Promise<VenueTrade[]> {
    const trades: VenueTrade[] = []
    let cursor = ''
    while (trades.length < limit) {
      const pageSize = Math.min(1000, limit - trades.length)
      const url = `${BASE}/markets/trades?limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}`
      const page = await fetchJson<{ cursor: string, trades: KalshiTrade[] }>(url)
      if (!page?.trades?.length)
        break
      for (const t of page.trades) {
        const side = t.taker_side === 'no' ? 'no' : 'yes'
        const price = Number.parseFloat(side === 'yes' ? t.yes_price_dollars : t.no_price_dollars)
        const size = Number.parseFloat(t.count_fp)
        if (!Number.isFinite(price) || !Number.isFinite(size))
          continue
        trades.push({
          venue: 'kalshi',
          externalId: t.trade_id,
          marketExternalId: t.ticker,
          side,
          price,
          size,
          notional: Math.round(size * price * 100) / 100,
          tradedAt: t.created_time,
        })
      }
      cursor = page.cursor
      if (!cursor)
        break
    }
    return trades
  }

  async fetchMarketsByIds(externalIds: string[]): Promise<VenueMarket[]> {
    const markets: VenueMarket[] = []
    for (const batch of chunk(externalIds, 40)) {
      const url = `${BASE}/markets?tickers=${batch.map(encodeURIComponent).join(',')}`
      const page = await fetchJson<{ markets: KalshiMarket[] }>(url)
      for (const m of page?.markets ?? []) {
        markets.push({
          venue: 'kalshi',
          externalId: m.ticker,
          question: m.title,
          // Kalshi lists a fixture as one market per outcome, all sharing
          // a title, so without this the rows are indistinguishable.
          outcomeLabel: m.yes_sub_title ?? '',
          category: m.category ?? '',
          status: normalizeStatus(m.status),
          result: m.result ?? '',
          volume: Number.parseFloat(m.volume_fp ?? '0') || 0,
          liquidity: Number.parseFloat(m.liquidity_dollars ?? '0') || 0,
          lastPrice: Number.parseFloat(m.last_price_dollars ?? '0') || 0,
          endsAt: m.close_time ?? '',
        })
      }
    }
    return markets
  }
}
