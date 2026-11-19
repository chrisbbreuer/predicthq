import type { Database } from '../../Support/db'
import type { LiveLine } from './line-snapshots'
import type { SlatePick } from './slate'
import { propParlays } from './prop-parlays'
import { liveLines } from './line-snapshots'
import { placePaperParlay } from './paper-parlays'
import { propLines } from './props'
import { assembleParlay, buildSlate, ensurePaperStrategy, parlayExpectedReturn, pickLeg, placePaperSingle, rankPicks } from './slate'

/**
 * Bet suggestions: singles and parlays PredictHQ proposes on the bets page,
 * for the user to approve (recorded as paper bets), bet themselves on Kalshi,
 * or dismiss. Nothing here moves money.
 *
 * Picks come from the slate: sportsbook line against Kalshi before a game,
 * Kalshi's own favourite during one. See `slate.ts` for why, and for what the
 * expected-return figure means.
 */

export type SuggestionLeg = ReturnType<typeof pickLeg>

export interface Suggestion {
  id: number
  kind: 'single' | 'parlay'
  legs: SuggestionLeg[]
  stake: number
  price: number
  ev: number
  rationale: string
  status: 'pending' | 'approved' | 'dismissed' | 'expired'
  expiresAt: string
  decidedAt: string
  outcome: string
  createdAt: string
}

/** Name of the paper strategy approved suggestions are recorded under. */
export const APPROVED_STRATEGY = 'Approved suggestions'

/** How long a suggestion with a live leg stays good: in-play prices move in seconds. */
const LIVE_SHELF_MS = 15 * 60_000

function signature(legs: SuggestionLeg[]): string {
  return legs.map(leg => `${leg.ticker}:${leg.side}`).sort().join('+').slice(0, 255)
}

/** When the suggestion stops being good: the first leg's start, or soon for a live leg. */
function expiry(legs: SuggestionLeg[], now: number): string {
  const ends = legs.map(leg => (leg.live ? now + LIVE_SHELF_MS : Date.parse(leg.startsAt)))
  return new Date(Math.min(...ends)).toISOString()
}

/**
 * Save suggestions for the user, skipping any bet already suggested today
 * (pending, approved or dismissed), so a dismissed bet does not come back.
 */
export async function saveSuggestions(db: Database, userId: number, bets: Array<{ kind: 'single' | 'parlay', picks: SlatePick[], stake: number }>, now = Date.now()): Promise<number> {
  const since = new Date(now - 24 * 3_600_000).toISOString()
  let saved = 0
  for (const bet of bets) {
    const legs = bet.picks.map(pickLeg)
    const sig = signature(legs)
    const seen = await db.query<{ id: number }>(`SELECT id FROM bet_suggestions WHERE user_id = ? AND signature = ? AND created_at >= ? LIMIT 1`).get(userId, sig, since)
    if (seen)
      continue
    const price = Math.round(legs.reduce((product, leg) => product * leg.price, 1) * 1_000_000) / 1_000_000
    const ev = bet.kind === 'single' ? legs[0]!.ev : parlayExpectedReturn(bet.picks)
    const stamp = new Date(now).toISOString()
    await db.query(`
      INSERT INTO bet_suggestions (user_id, kind, legs, signature, stake, price, ev, rationale, status, expires_at, decided_at, outcome, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', '', ?, ?)
    `).run(userId, bet.kind, JSON.stringify(legs), sig, bet.stake, price, ev, (bet.kind === 'parlay' ? 'Paper parlay; payout assumes independent legs and is not a Kalshi combo quote. ' : '') + legs.map(leg => leg.rationale).join(' · '), expiry(legs, now), stamp, stamp)
    saved++
  }
  return saved
}

/**
 * Build fresh suggestions from today's games: up to three singles and two
 * parlays from games before tip-off; while games run, all-live parlays and
 * one led by a live leg; and up to two player-prop parlays. Every parlay pays
 * at least 2×.
 */
export async function generateSuggestions(db: Database, userId: number, options: { lines?: LiveLine[], props?: LiveLine[], stake?: number, now?: number } = {}): Promise<number> {
  const stake = options.stake ?? 1
  const now = options.now ?? Date.now()
  // Only games that start today, US Eastern, so every suggestion settles tonight.
  const lines = (options.lines ?? await liveLines(undefined, 18 * 60, { includeLive: true }))
    .filter(line => Number.isFinite(Date.parse(line.startsAt)) && easternDay(Date.parse(line.startsAt)) === easternDay(now))
  const pre = rankPicks(lines.filter(line => !line.live && line.minutes >= 15), { minGap: 0.01 })
    // Not worth showing a bet expected to lose more than 3% even if the book is right.
    .filter(pick => pick.ev > -0.03)
  const live = rankPicks(lines.filter(line => line.live), { minGap: 0 })
    // In play, favourites priced 55–85¢: the likelier leg, at a bounded cost.
    .filter(pick => pick.price >= 0.55 && pick.price <= 0.85)
    .sort((a, b) => a.line.ask - a.line.bid - (b.line.ask - b.line.bid))

  const slate = buildSlate(pre, { budget: 5, stake, singles: 3 })
  const bets: Array<{ kind: 'single' | 'parlay', picks: SlatePick[], stake: number }> = [
    ...slate.singles.map(pick => ({ kind: 'single' as const, picks: [pick], stake })),
    ...slate.parlays.map(picks => ({ kind: 'parlay' as const, picks, stake })),
  ]
  // Live parlays while games run: up to two all-live ones from different
  // legs, and one led by the best live leg with pre-game picks after it.
  // Each is built to pay at least 2× (`assembleParlay`), so favourites need
  // more legs. Picks are one per game already, so legs never share a game.
  let livePool = live
  for (let i = 0; i < 2; i++) {
    const parlay = assembleParlay(livePool, { stake })
    if (!parlay)
      break
    bets.push({ kind: 'parlay', picks: parlay, stake })
    livePool = livePool.filter(pick => !parlay.includes(pick))
  }
  if (live[0]) {
    const mixed = assembleParlay(pre, { start: [live[0]], stake })
    if (mixed)
      bets.push({ kind: 'parlay', picks: mixed, stake })
  }

  // Player-prop parlays, pre-game or live: the cheapest legs, not "edges"
  // (see props.ts). Overs bought down to 75–84¢ (four of them reach 2×) with a spread of 2¢ or less,
  // one line per game, lowest cost first, assembled to pay at least 2×.
  const props = (options.props ?? await propLines())
    .filter(line => line.live || Date.parse(line.startsAt) > now + 15 * 60_000)
    .filter(line => Number.isFinite(Date.parse(line.startsAt)) && easternDay(Date.parse(line.startsAt)) === easternDay(now))
    .filter(line => line.ask >= 0.75 && line.ask <= 0.84 && line.ask - line.bid >= 0 && line.ask - line.bid <= 0.02 + 1e-8)
  for (const picks of propParlays(props, { stake }))
    bets.push({ kind: 'parlay', picks, stake })
  return await saveSuggestions(db, userId, bets, now)
}

/** The calendar day in US Eastern, where the schedule's "today" lives. */
export function easternDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

function toSuggestion(row: Record<string, unknown>): Suggestion {
  return {
    id: Number(row.id),
    kind: String(row.kind) as Suggestion['kind'],
    legs: JSON.parse(String(row.legs || '[]')),
    stake: Number(row.stake),
    price: Number(row.price),
    ev: Number(row.ev),
    rationale: String(row.rationale ?? ''),
    status: String(row.status) as Suggestion['status'],
    expiresAt: String(row.expires_at),
    decidedAt: String(row.decided_at ?? ''),
    outcome: String(row.outcome ?? ''),
    createdAt: String(row.created_at ?? ''),
  }
}

/** Pending suggestions that are still good, then the last few decided. */
export async function listSuggestions(db: Database, userId: number, now = Date.now()): Promise<{ pending: Suggestion[], recent: Suggestion[] }> {
  const stamp = new Date(now).toISOString()
  await db.query(`UPDATE bet_suggestions SET status = 'expired', updated_at = ? WHERE user_id = ? AND status = 'pending' AND expires_at < ?`).run(stamp, userId, stamp)
  const pending = (await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY ev DESC, id DESC LIMIT 20`).all(userId)).map(toSuggestion)
  const recent = (await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE user_id = ? AND status IN ('approved', 'dismissed') ORDER BY id DESC LIMIT 8`).all(userId)).map(toSuggestion)
  return { pending, recent }
}

async function pendingSuggestion(db: Database, userId: number, id: number, now = Date.now()): Promise<Suggestion> {
  const row = await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE id = ? AND user_id = ?`).get(id, userId)
  if (!row)
    throw new Error('That suggestion is not yours or no longer exists.')
  const suggestion = toSuggestion(row)
  if (suggestion.status !== 'pending')
    throw new Error(`That suggestion was already ${suggestion.status}.`)
  if (Date.parse(suggestion.expiresAt) < now)
    throw new Error('That suggestion has expired: its price no longer holds.')
  return suggestion
}

/** Record the suggestion as a paper bet under the user's "Approved suggestions" strategy. */
export async function approveSuggestion(db: Database, userId: number, id: number, now = Date.now()): Promise<Suggestion> {
  const suggestion = await pendingSuggestion(db, userId, id, now)
  const strategyId = await ensurePaperStrategy(db, userId, APPROVED_STRATEGY, 100, suggestion.stake)
  let outcome: string
  if (suggestion.kind === 'single') {
    const result = await placePaperSingle(db, strategyId, suggestion.legs[0]!, suggestion.stake)
    if (!result.placed)
      throw new Error(`Could not record it: ${result.reason}`)
    outcome = 'paper single'
  }
  else {
    const parlayId = await placePaperParlay(db, {
      userId,
      strategyId,
      stake: suggestion.stake,
      legs: suggestion.legs.map(leg => ({ ticker: leg.ticker, side: leg.side, price: leg.price, label: leg.label })),
      rationale: suggestion.rationale,
    })
    outcome = `paper parlay #${parlayId}`
  }
  const stamp = new Date().toISOString()
  await db.query(`UPDATE bet_suggestions SET status = 'approved', decided_at = ?, outcome = ?, updated_at = ? WHERE id = ?`).run(stamp, outcome, stamp, id)
  return { ...suggestion, status: 'approved', decidedAt: stamp, outcome }
}

export async function dismissSuggestion(db: Database, userId: number, id: number, now = Date.now()): Promise<void> {
  await pendingSuggestion(db, userId, id, now)
  const stamp = new Date().toISOString()
  await db.query(`UPDATE bet_suggestions SET status = 'dismissed', decided_at = ?, updated_at = ? WHERE id = ?`).run(stamp, stamp, id)
}
