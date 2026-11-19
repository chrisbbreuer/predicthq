import type { Database } from '../../Support/db'
import type { LiveLine } from './line-snapshots'
import type { SlatePick } from './slate'
import { liveLines } from './line-snapshots'
import { parlayPayout, placePaperParlay } from './paper-parlays'
import { propParlays } from './prop-parlays'
import { propLines } from './props'
import { assembleParlay, buildSlate, ensurePaperStrategy, parlayExpectedReturn, pickLeg, placePaperSingle, rankWinnerPicks } from './slate'
import { meetsPickConfidence, MIN_PICK_CONFIDENCE } from './winner-confidence'

/**
 * Bet suggestions: singles and parlays PredictHQ proposes on the bets page,
 * for the user to approve (recorded as paper bets), bet themselves on Kalshi,
 * or dismiss. Nothing here moves money.
 *
 * Winner picks use Kalshi's probability before and during games. Sportsbook
 * lines, when available, still inform the expected-return figure.
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

interface SlateTicketReference {
  suggestionId: number
  paperId?: number
  kalshiEventUrl?: string
}

type PaperResult = 'pending' | 'won' | 'lost' | 'partial'

interface SlateTicket extends Suggestion {
  canApprove: boolean
  paperResult: PaperResult | null
  paperPayout: number | null
  kalshiOrderUrl: string | null
}

interface SuggestionSlate {
  name: string
  createdAt: string
  tickets: SlateTicket[]
  alternatives: SlateTicket[]
}

/** Name of the paper strategy approved suggestions are recorded under. */
export const APPROVED_STRATEGY = 'Approved suggestions'

/** How long a suggestion with a live leg stays good: in-play prices move in seconds. */
const LIVE_SHELF_MS = 15 * 60_000

function legKey(legs: Pick<SuggestionLeg, 'ticker' | 'side'>[]): string {
  return legs.map(leg => `${leg.ticker}:${leg.side}`).sort().join('+')
}

function eligibleLegs(legs: SuggestionLeg[]): boolean {
  return legs.length > 0 && legs.every(leg => meetsPickConfidence(leg.confidence ?? (leg.side === 'yes' ? leg.yesMid : 1 - leg.yesMid)))
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
    if (!eligibleLegs(legs))
      continue
    const sig = legKey(legs).slice(0, 255)
    const seen = await db.query<{ status: string, legs: string }>(`SELECT status, legs FROM bet_suggestions WHERE user_id = ? AND signature = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(userId, sig, since)
    if (seen && (seen.status !== 'pending' || eligibleLegs(JSON.parse(seen.legs))))
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
  const lines = (options.lines ?? await liveLines(undefined, 18 * 60, { includeLive: true, allowKalshiOnly: true }))
    .filter(line => Number.isFinite(Date.parse(line.startsAt)) && easternDay(Date.parse(line.startsAt)) === easternDay(now))
  const pre = rankWinnerPicks(lines.filter(line => !line.live && line.minutes >= 15))
  const live = rankWinnerPicks(lines.filter(line => line.live))

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

async function savedSlate(db: Database, userId: number): Promise<{ name: string, createdAt: string, refs: SlateTicketReference[] } | null> {
  const row = await db.query<{ name: string, tickets: string, created_at: string }>(`
    SELECT name, tickets, created_at FROM suggestion_slates WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(userId)
  return row ? { name: row.name, createdAt: row.created_at, refs: JSON.parse(row.tickets) } : null
}

async function paperResult(db: Database, userId: number, suggestion: Suggestion, paperId: number): Promise<PaperResult | null> {
  if (suggestion.kind === 'single') {
    const leg = suggestion.legs[0]
    if (!leg)
      return null
    const position = await db.query<{ status: string, settlement_price: number }>(`
      SELECT p.status, p.settlement_price FROM exchange_positions p
      JOIN trading_strategies s ON s.id = p.trading_strategy_id
      WHERE p.id = ? AND s.user_id = ? AND s.mode = 'paper' AND p.venue = 'paper:kalshi'
        AND p.market_external_id = ? AND p.side = ?
    `).get(paperId, userId, leg.ticker, leg.side)
    if (!position)
      return null
    if (position.status !== 'settled')
      return 'pending'
    const price = Number(position.settlement_price)
    return price === 1 ? 'won' : price === 0 ? 'lost' : 'partial'
  }

  const parlay = await db.query<{ status: string, stake: number, legs: string }>(`
    SELECT status, stake, legs FROM paper_parlays WHERE id = ? AND user_id = ?
  `).get(paperId, userId)
  if (!parlay || Number(parlay.stake) !== suggestion.stake || legKey(JSON.parse(parlay.legs)) !== legKey(suggestion.legs))
    return null
  if (parlay.status === 'won' || parlay.status === 'lost')
    return parlay.status
  return parlay.status === 'settled' ? 'partial' : 'pending'
}

async function listSlate(db: Database, userId: number, now: number): Promise<SuggestionSlate | null> {
  const slate = await savedSlate(db, userId)
  if (!slate?.refs.length)
    return null
  const ids = slate.refs.map(ref => ref.suggestionId)
  const rows = await db.query<Record<string, unknown>>(`
    SELECT * FROM bet_suggestions WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})
  `).all(userId, ...ids)
  const suggestions = new Map(rows.map((row) => {
    const suggestion = toSuggestion(row)
    return [suggestion.id, suggestion]
  }))
  const tickets: SlateTicket[] = []
  const alternatives: SlateTicket[] = []
  for (const ref of slate.refs) {
    const suggestion = suggestions.get(ref.suggestionId)
    if (!suggestion)
      continue
    const paperId = ref.paperId ?? Number(suggestion.outcome.match(/^paper parlay #(\d+)$/)?.[1])
    const result = paperId ? await paperResult(db, userId, suggestion, paperId) : null
    const group = ref.paperId ? tickets : alternatives
    group.push({
      ...suggestion,
      canApprove: suggestion.status === 'pending' && (!ref.paperId || result === 'pending') && eligibleLegs(suggestion.legs),
      paperResult: result,
      paperPayout: suggestion.kind === 'parlay' && suggestion.price > 0 ? parlayPayout(suggestion.stake, suggestion.price) : null,
      kalshiOrderUrl: suggestion.kind === 'single' && result === 'pending'
        && (suggestion.status === 'pending' || suggestion.status === 'approved')
        && Date.parse(suggestion.expiresAt) > now
        ? kalshiOrderUrl(ref.kalshiEventUrl, suggestion.legs[0])
        : null,
    })
  }
  return tickets.length || alternatives.length ? { name: slate.name, createdAt: slate.createdAt, tickets, alternatives } : null
}

function kalshiOrderUrl(eventUrl: string | undefined, leg: SuggestionLeg | undefined): string | null {
  if (!eventUrl || !leg)
    return null
  const url = URL.parse(eventUrl)
  if (url?.origin !== 'https://kalshi.com' || !url.pathname.startsWith('/markets/'))
    return null
  url.search = new URLSearchParams({
    op_market_ticker: leg.ticker,
    op_order_side: leg.side,
    op_order_type: 'dollars',
    op_side: 'buy',
  }).toString()
  return url.href
}

/** The saved slate, pending suggestions that are still good, and recent decisions. */
export async function listSuggestions(db: Database, userId: number, now = Date.now()): Promise<{ slate: SuggestionSlate | null, pending: Suggestion[], recent: Suggestion[] }> {
  const stamp = new Date(now).toISOString()
  await db.query(`UPDATE bet_suggestions SET status = 'expired', updated_at = ? WHERE user_id = ? AND status = 'pending' AND expires_at < ?`).run(stamp, userId, stamp)
  const slate = await listSlate(db, userId, now)
  const slateIds = new Set(slate ? [...slate.tickets, ...slate.alternatives].map(ticket => ticket.id) : [])
  const pending = (await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY ev DESC, id DESC`).all(userId))
    .map(toSuggestion).filter(suggestion => !slateIds.has(suggestion.id) && eligibleLegs(suggestion.legs)).slice(0, 20)
  const recent = (await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE user_id = ? AND status IN ('approved', 'dismissed') ORDER BY id DESC LIMIT 8`).all(userId)).map(toSuggestion)
  return { slate, pending, recent }
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

export async function suggestionForReview(db: Database, userId: number, id: number, now = Date.now()): Promise<Suggestion | null> {
  const row = await db.query<Record<string, unknown>>(`SELECT * FROM bet_suggestions WHERE id = ? AND user_id = ?`).get(id, userId)
  if (!row)
    return null
  const ticket = toSuggestion(row)
  if ((ticket.status !== 'pending' && ticket.status !== 'approved') || !(Date.parse(ticket.expiresAt) > now) || !eligibleLegs(ticket.legs))
    return null
  return ticket
}

/** Approve an existing slate ticket or record a new paper bet under "Approved suggestions". */
export async function approveSuggestion(db: Database, userId: number, id: number, now = Date.now()): Promise<Suggestion> {
  const suggestion = await pendingSuggestion(db, userId, id, now)
  if (!eligibleLegs(suggestion.legs))
    throw new Error(`Every suggestion leg needs at least ${MIN_PICK_CONFIDENCE * 100}% confidence.`)
  const ref = (await savedSlate(db, userId))?.refs.find(ticket => ticket.suggestionId === id)
  const stamp = new Date(now).toISOString()
  const markApproved = async (connection: Database, outcome: string) => {
    const updated = await connection.query(`
      UPDATE bet_suggestions SET status = 'approved', decided_at = ?, outcome = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?
    `).run(stamp, outcome, stamp, id, userId, stamp)
    if (!updated.changes)
      throw new Error('This suggestion has already been decided or has expired.')
  }
  if (ref?.paperId) {
    if (await paperResult(db, userId, suggestion, ref.paperId) !== 'pending')
      throw new Error('The paper position for this slate ticket is unavailable or settled.')
    const outcome = `paper ${suggestion.kind} #${ref.paperId}`
    await markApproved(db, outcome)
    return { ...suggestion, status: 'approved', decidedAt: stamp, outcome }
  }

  return await db.transaction(async (transaction) => {
    await markApproved(transaction, '')
    const strategyId = await ensurePaperStrategy(transaction, userId, APPROVED_STRATEGY, 100, suggestion.stake)
    let outcome = 'paper single'
    if (suggestion.kind === 'single') {
      const result = await placePaperSingle(transaction, strategyId, suggestion.legs[0]!, suggestion.stake)
      if (!result.placed)
        throw new Error(`Could not record it: ${result.reason}`)
    }
    else {
      const parlayId = await placePaperParlay(transaction, {
        userId,
        strategyId,
        stake: suggestion.stake,
        legs: suggestion.legs.map(leg => ({ ticker: leg.ticker, side: leg.side, price: leg.price, label: leg.label })),
        rationale: suggestion.rationale,
      })
      outcome = `paper parlay #${parlayId}`
    }
    await transaction.query('UPDATE bet_suggestions SET outcome = ? WHERE id = ? AND user_id = ?').run(outcome, id, userId)
    return { ...suggestion, status: 'approved', decidedAt: stamp, outcome }
  })
}

export async function dismissSuggestion(db: Database, userId: number, id: number, now = Date.now()): Promise<void> {
  await pendingSuggestion(db, userId, id, now)
  const stamp = new Date(now).toISOString()
  const updated = await db.query(`
    UPDATE bet_suggestions SET status = 'dismissed', decided_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?
  `).run(stamp, stamp, id, userId, stamp)
  if (!updated.changes)
    throw new Error('This suggestion has already been decided or has expired.')
}
