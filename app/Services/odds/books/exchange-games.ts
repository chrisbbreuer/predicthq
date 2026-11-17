import type { Game } from '../../scores/espn'
import type { GameTickerRef } from '../../trading/live-games'
import { gamesOn, matchGame } from '../../trading/live-games'

/**
 * Pinning an exchange's game to the game everyone else is quoting.
 *
 * Kalshi and Polymarket name teams the way a trader reads them — "Los
 * Angeles L", "Spurs" — not the way a sportsbook does. Handing those
 * strings to team resolution would either fail or, worse, mint a second
 * "Spurs" beside "San Antonio Spurs" and split one game's prices across
 * two events.
 *
 * Both venues do publish the teams' abbreviations and the date, which is
 * exactly what ESPN's scoreboard is keyed by. Matching there gives the
 * canonical names and the real start time (Kalshi only publishes an
 * expiry, hours after the final whistle), so the event an exchange price
 * lands on is the same event the books' prices land on.
 */

/** ESPN's games for one league, for every date asked about, flattened. */
export async function gamesForDates(league: string, dates: Iterable<string>, loader: (league: string, date: string) => Promise<Game[]> = gamesOn): Promise<Map<string, Game[]>> {
  const out = new Map<string, Game[]>()
  for (const date of new Set(dates)) {
    try {
      out.set(date, await loader(league, date))
    }
    catch {
      out.set(date, [])
    }
  }
  return out
}

/**
 * The game two team codes and a date describe, trying the codes first and
 * each team's own wording after.
 */
export function findGame(league: string, date: string, code: string, games: Game[], hints: string[] = []): Game | null {
  const ref: GameTickerRef = {
    series: '',
    league,
    date,
    code: code.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    outcome: '',
    eventTicker: '',
    winner: true,
  }
  for (const hint of ['', ...hints]) {
    const game = matchGame(ref, games, hint)
    if (game)
      return game
  }
  return null
}

/** A share price strictly between $0 and $1, or null. */
export function share(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : null
}

/**
 * The widest bid-ask spread still treated as a price.
 *
 * An exchange quote with no bid, or a 94¢ ask over a 1¢ bid on a match
 * three weeks out, is not a price anyone agrees on; it is a resting order
 * nobody wants. Storing it would put a 1.06 on the board beside books
 * quoting 3.20.
 */
export const MAX_SPREAD = 0.1

/**
 * Decimal odds for backing an outcome: 1 / the ask, when the outcome has a
 * two-sided market no wider than {@link MAX_SPREAD}. Null otherwise.
 */
export function quotable(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || ask < bid || ask - bid > MAX_SPREAD + 1e-9)
    return null
  return Math.round((1 / ask) * 10_000) / 10_000
}

/**
 * Games worth holding a socket for: starting within a day and a half, or
 * started within the last six hours. Further out, prices barely move and
 * polling at the slow cadence covers them.
 */
export function streamable(commenceAt: string, now = Date.now()): boolean {
  const start = Date.parse(commenceAt)
  return Number.isFinite(start) && start >= now - 6 * 3_600_000 && start <= now + 36 * 3_600_000
}
