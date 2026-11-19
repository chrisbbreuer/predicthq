import type { LiveLine } from './line-snapshots'
import type { SlatePick } from './slate'
import { parlayPayout } from './paper-parlays'
import { MAX_PARLAY_LEGS, MIN_PARLAY_PAYOUT, parlayExpectedReturn, pickFor } from './slate'

/** Compare complete paper combinations, retaining alternate prices per game.
 * Greedily keeping only each game's 84-cent leg can miss a viable 80-cent
 * alternative when four 84-cent legs fall below the net payout floor.
 */
export function propParlays(lines: LiveLine[], options: { stake?: number, count?: number } = {}): SlatePick[][] {
  const stake = options.stake ?? 1
  const byGame = new Map<string, Map<number, SlatePick>>()
  for (const line of lines) {
    const pick = pickFor(line, 'yes')
    if (!pick) continue
    const prices = byGame.get(line.gameId) ?? new Map<number, SlatePick>()
    const held = prices.get(pick.price)
    // At the same price, only the tightest spread can improve this combination.
    if (!held || pick.ev > held.ev) prices.set(pick.price, pick)
    byGame.set(line.gameId, prices)
  }
  const out: SlatePick[][] = []
  for (let n = 0; n < (options.count ?? 2); n++) {
    const games = [...byGame.values()].map(prices => [...prices.values()].sort((a, b) => b.ev - a.ev))
    let best: SlatePick[] | null = null
    let bestEv = -Infinity
    const visit = (start: number, legs: SlatePick[], price: number, fair: number) => {
      if (legs.length >= 2 && parlayPayout(stake, price) >= MIN_PARLAY_PAYOUT * stake) {
        const ev = parlayExpectedReturn(legs)
        if (ev > bestEv) { best = [...legs]; bestEv = ev }
        return
      }
      if (legs.length >= MAX_PARLAY_LEGS) return
      // With mid-priced legs, adding another leg can only increase expected cost.
      // This is an upper bound before the additional spread and higher fee.
      if (legs.length > 0 && (fair - price - 0.07 * price * (1 - price)) / price < bestEv - 0.0001) return
      for (let i = start; i < games.length; i++) {
        for (const pick of games[i]!)
          visit(i + 1, [...legs, pick], price * pick.price, fair * pick.fair)
      }
    }
    visit(0, [], 1, 1)
    if (!best) break
    const selected: SlatePick[] = best
    out.push(selected)
    for (const pick of selected) byGame.delete(pick.line.gameId)
  }
  return out
}
