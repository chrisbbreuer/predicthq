import { espnFetch } from '../scores/espn-client'
import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { LiveLine } from './line-snapshots'
import type { LiveGame } from './live-games'
import { kalshiSeriesOpenMarkets } from '../prediction-markets/kalshi-public'
import { liveGameFor } from './live-games'

/**
 * Kalshi's NBA player props as lines the slate can use.
 *
 * Replaying 12,824 settled props (Nov 11–18) against a model built from each
 * player's game logs found Kalshi's prices more accurate (Brier 0.1600 vs
 * 0.1715) on every stat, and betting the model's disagreements made +3% one
 * half and −11.5% the next. So a prop leg is priced at Kalshi's own mid and
 * claims no edge. What a parlay of them can do is cost as little as possible:
 * with no edge, the expected loss is the spread plus the fee, and both are
 * smallest relative to the stake on high-probability lines with a tight
 * spread, which is what "buying points" down to a lower line gets.
 */

/** Kalshi's NBA prop series, and the stat each counts. */
export const PROP_SERIES: Record<string, string> = {
  KXNBAPTS: 'points',
  KXNBAREB: 'rebounds',
  KXNBAAST: 'assists',
  KXNBA3PT: 'threes',
  KXNBAPRA: 'pts+reb+ast',
}

export interface PropDeps {
  openMarkets: (series: string) => Promise<KalshiMarketInfo[]>
  gameFor: (ticker: string) => Promise<LiveGame | null>
  now: () => number
  unavailable?: () => Promise<Set<string>>
}

const defaultDeps: PropDeps = {
  openMarkets: series => kalshiSeriesOpenMarkets(series),
  gameFor: ticker => liveGameFor(ticker, 'yes'),
  now: () => Date.now(),
  unavailable: async () => {
    const res = await espnFetch('https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', { ttlMs: 5 * 60_000 })
    if (!res?.ok) return new Set()
    const data: any = await res.json()
    return new Set((data?.injuries ?? []).flatMap((team: any) => (team.injuries ?? [])
      .filter((item: any) => /^(out|doubtful)$/i.test(String(item.status ?? '')))
      .map((item: any) => playerKey(String(item.athlete?.displayName ?? '')))))
  },
}

function playerKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')
}

/** "Luka Dončić: 25+" → name and threshold, or null. */
export function parsePropTitle(title: string): { name: string, threshold: number } | null {
  const match = String(title).match(/^(.+?):\s*(\d+)\+\s*$/)
  return match ? { name: match[1]!.trim(), threshold: Number(match[2]) } : null
}

/**
 * Every open prop on a game that has not finished, with a quote no wider
 * than `maxSpread`. Parlays retain the underlying game identity to avoid multiplying
 * correlated same-game legs as though they were independent.
 */
export async function propLines(deps: PropDeps = defaultDeps, options: { maxSpread?: number } = {}): Promise<LiveLine[]> {
  const maxSpread = options.maxSpread ?? 0.03
  const now = deps.now()
  const unavailable = await deps.unavailable?.().catch(() => new Set<string>()) ?? new Set<string>()
  const games = new Map<string, Promise<LiveGame | null>>()
  const out: LiveLine[] = []
  for (const [series, stat] of Object.entries(PROP_SERIES)) {
    const markets = await deps.openMarkets(series).catch(() => [] as KalshiMarketInfo[])
    for (const market of markets) {
      const { yesBid: bid, yesAsk: ask } = market
      if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask > 1 || ask <= 0 || bid > ask || ask - bid > maxSpread + 1e-8 || !['active', 'open'].includes(market.status))
        continue
      const parsed = parsePropTitle(market.yesSubTitle)
      if (!parsed)
        continue
      const event = market.eventTicker.split('-')[1] ?? market.eventTicker
      if (!games.has(event))
        games.set(event, deps.gameFor(market.ticker).catch(() => null))
      const game = await games.get(event)
      if (!game || !Number.isFinite(Date.parse(game.startsAt)) || (game.state !== 'pre' && game.state !== 'in'))
        continue
      if (game.state === 'pre' && unavailable.has(playerKey(parsed.name)))
        continue
      out.push({
        ticker: market.ticker,
        title: `${parsed.name}: ${parsed.threshold}+ ${stat}`,
        league: 'nba-props',
        gameId: game.gameId,
        side: 'home',
        provider: 'Kalshi',
        bookProb: Math.round(((bid + ask) / 2) * 10000) / 10000,
        bid,
        ask,
        minutes: Math.round((Date.parse(game.startsAt) - now) / 60_000),
        startsAt: game.startsAt,
        live: game.state === 'in',
        prop: true,
      })
    }
  }
  return out
}
