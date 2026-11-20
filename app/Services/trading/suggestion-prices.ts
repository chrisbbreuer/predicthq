import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { Suggestion } from './suggestions'
import { kalshiMarkets } from '../prediction-markets/kalshi-public'
import { parlayPayout } from './paper-parlays'
import { meetsPickConfidence } from './winner-confidence'

interface LegQuote {
  bid: number
  ask: number
  confidence: number
}

interface SuggestionQuote {
  legs: Array<LegQuote | null>
  paperPayout: number | null
  flag: 'missing' | 'confidence' | 'spread' | 'payout' | null
}

function quoteLeg(market: KalshiMarketInfo | undefined, side: 'yes' | 'no'): LegQuote | null {
  if (!market || (market.status !== 'active' && market.status !== 'open'))
    return null
  const bid = side === 'yes' ? market.yesBid : market.noBid
  const ask = side === 'yes' ? market.yesAsk : market.noAsk
  if (bid == null || ask == null || bid <= 0 || ask < bid || ask >= 1)
    return null
  return { bid, ask, confidence: (bid + ask) / 2 }
}

/** Recheck the executable sides from the public order book before the user opens a ticket. */
export async function suggestionPrices(
  tickets: Array<Suggestion & { minReturnMultiple?: number }>,
  load: typeof kalshiMarkets = kalshiMarkets,
  now = Date.now(),
): Promise<Record<number, SuggestionQuote>> {
  const active = tickets.filter(ticket => (ticket.status === 'pending' || ticket.status === 'approved')
    && Date.parse(ticket.expiresAt) > now && ticket.legs.length > 0)
  if (active.length === 0)
    return {}

  const tickers = active.flatMap(ticket => ticket.legs.map(leg => leg.ticker))
  const markets = await load(tickers, 30_000).catch(() => new Map<string, KalshiMarketInfo>())
  const quotes: Record<number, SuggestionQuote> = {}
  for (const ticket of active) {
    const legs = ticket.legs.map(leg => quoteLeg(markets.get(leg.ticker), leg.side))
    if (legs.some(leg => leg === null)) {
      quotes[ticket.id] = { legs, paperPayout: null, flag: 'missing' }
      continue
    }

    const priced = legs.filter(leg => leg !== null)
    const price = priced.reduce((product, leg) => product * leg.ask, 1)
    const payout = ticket.kind === 'parlay' ? parlayPayout(ticket.stake, price) : null
    let flag: SuggestionQuote['flag'] = null
    if (priced.some(leg => !meetsPickConfidence(leg.confidence)))
      flag = 'confidence'
    else if (payout !== null && priced.some(leg => leg.ask - leg.bid > 0.02 + 1e-8))
      flag = 'spread'
    else if (payout !== null && payout < (ticket.minReturnMultiple ?? 2) * ticket.stake)
      flag = 'payout'
    quotes[ticket.id] = { legs, paperPayout: payout, flag }
  }
  return quotes
}
