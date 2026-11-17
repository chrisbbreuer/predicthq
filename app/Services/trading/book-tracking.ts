import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { LiveGame } from './live-games'
import type { fetchScoreboard } from '../scores/espn'
import { kalshiChart } from '../prediction-markets/kalshi-chart'
import { currentPrice, kalshiMarkets } from '../prediction-markets/kalshi-public'
import { liveGameFor } from './live-games'

/**
 * What makes a holding followable: the game it rides on, each leg of a
 * parlay, and how its probability has moved.
 *
 * Everything here is public market and score data looked up for tickers
 * the caller has already established the user holds. Nothing accepts a
 * ticker from a request without that check, so it cannot be used to
 * enumerate anyone else's book.
 *
 * Every lookup is best-effort. A score feed or a candle endpoint going
 * quiet costs the page its decorations, never the positions themselves.
 */

export interface ParlayLeg {
  ticker: string
  label: string
  choice: 'yes' | 'no'
  /** Probability the leg goes the holder's way, 0..1, when quoted. */
  chance: number | null
  /** 'won' | 'lost' | 'live' | 'open' */
  status: string
  game: LiveGame | null
}

export interface ParlayTracker {
  total: number
  won: number
  lost: number
  live: number
  open: number
  /** Product of the open legs' chances: what the market says is left. */
  chance: number | null
  legs: ParlayLeg[]
}

export interface HoldingTrack {
  game: LiveGame | null
  parlay: ParlayTracker | null
  /** The holder's side's probability over time, `[unixSeconds, p]`. */
  spark: Array<[number, number]>
  /** Live probability of the holder's side, 0..1. */
  chance: number | null
  /** When the event happens, for a game its scheduled start. */
  occursAt: string
}

export interface TrackableHolding {
  venue: string
  marketExternalId: string
  side: string
  outcomeLabel?: string
}

interface TrackOptions {
  loadScoreboard?: typeof fetchScoreboard
  /** Upper bound on how long decorations may hold up the response. */
  budgetMs?: number
  /** Skip candle reads (sparklines), for callers that do not draw them. */
  sparklines?: boolean
}

export function trackKey(holding: Pick<TrackableHolding, 'venue' | 'marketExternalId' | 'side'>): string {
  return `${holding.venue}:${holding.marketExternalId}:${String(holding.side).toLowerCase()}`
}

/** Strip the `yes `/`no ` Kalshi puts in front of each parlay condition. */
function legLabels(market: KalshiMarketInfo): string[] {
  return market.yesSubTitle.split(',').map(part => part.trim().replace(/^(?:yes|no)\s+/i, '')).filter(Boolean)
}

function sideChance(price: number | null, side: string): number | null {
  if (price === null)
    return null
  return String(side).toLowerCase() === 'no' ? Math.round((1 - price) * 1000) / 1000 : price
}

/** The parlay's legs with their live probability and game. */
export async function trackParlay(
  market: KalshiMarketInfo,
  loadScoreboard?: typeof fetchScoreboard,
): Promise<ParlayTracker | null> {
  if (market.legs.length === 0)
    return null

  const labels = legLabels(market)
  const legMarkets = await kalshiMarkets(market.legs.map(leg => leg.marketTicker)).catch(() => new Map<string, KalshiMarketInfo>())

  const legs = await Promise.all(market.legs.map(async (leg, index): Promise<ParlayLeg> => {
    const info = legMarkets.get(leg.marketTicker)
    const game = await liveGameFor(leg.marketTicker, leg.side, loadScoreboard).catch(() => null)
    const settled = info?.result === 'yes' || info?.result === 'no'
    const status = settled
      ? (info!.result === leg.side ? 'won' : 'lost')
      : (game?.state === 'in' ? 'live' : 'open')

    return {
      ticker: leg.marketTicker,
      label: (labels.length === market.legs.length ? labels[index] : '') || info?.title || leg.marketTicker,
      choice: leg.side,
      chance: settled ? (status === 'won' ? 1 : 0) : sideChance(info ? currentPrice(info) : null, leg.side),
      status,
      game,
    }
  }))

  const open = legs.filter(leg => leg.status === 'open' || leg.status === 'live')
  const lost = legs.filter(leg => leg.status === 'lost').length
  const chance = lost > 0
    ? 0
    : (open.every(leg => leg.chance !== null)
        ? Math.round(open.reduce((product, leg) => product * (leg.chance ?? 1), 1) * 1000) / 1000
        : null)

  return {
    total: legs.length,
    won: legs.filter(leg => leg.status === 'won').length,
    lost,
    live: legs.filter(leg => leg.status === 'live').length,
    open: legs.filter(leg => leg.status === 'open').length,
    chance,
    legs,
  }
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(resolve, ms, fallback)),
  ])
}

/**
 * Decorations for every Kalshi holding, keyed by `trackKey`.
 *
 * One batched metadata read covers every ticker. Games and candles are
 * then fetched per holding in parallel, all under one time budget: the
 * page polls, so a slow decoration is better skipped this round than
 * allowed to make the portfolio itself feel slow.
 */
export async function trackHoldings(holdings: TrackableHolding[], options: TrackOptions = {}): Promise<Map<string, HoldingTrack>> {
  const kalshi = holdings.filter(holding => holding.venue === 'kalshi').slice(0, 40)
  const out = new Map<string, HoldingTrack>()
  if (kalshi.length === 0)
    return out

  const budget = options.budgetMs ?? 3_500
  const markets = await within(kalshiMarkets(kalshi.map(h => h.marketExternalId)), budget, new Map<string, KalshiMarketInfo>())

  await Promise.all(kalshi.map(async (holding) => {
    const market = markets.get(holding.marketExternalId)
    const parlay = market && market.legs.length > 0
      ? await within(trackParlay(market, options.loadScoreboard), budget, null)
      : null
    const game = parlay ? null : await within(liveGameFor(holding.marketExternalId, holding.side, options.loadScoreboard), budget, null)

    let spark: Array<[number, number]> = []
    if (options.sparklines !== false) {
      const chart = await within(
        kalshiChart(holding.marketExternalId, game?.state === 'in' ? 'live' : '1w', { single: true, liveSince: game?.startsAt ?? null }),
        budget,
        null,
      )
      spark = (chart?.outcomes[0]?.points ?? []).map(([ts, p]) => [ts, sideChance(p, holding.side) ?? p] as [number, number])
    }

    out.set(trackKey(holding), {
      game,
      parlay,
      spark,
      chance: parlay ? parlay.chance : sideChance(market ? currentPrice(market) : null, holding.side),
      occursAt: market?.occursAt ?? '',
    })
  }))

  return out
}
