import type { Database } from '../../Support/db'
import type { LiveLine } from './line-snapshots'
import type { PaperLeg } from './paper-parlays'
import { tradablePrice } from './evidence'
import { liveLines } from './line-snapshots'
import { executePaper } from './paper'
import { placePaperParlay } from './paper-parlays'
import { normalizeStrategyRow } from './run'

/**
 * A day's paper slate: a few $1 singles and two-leg parlays, picked where
 * the sportsbook's line disagrees most with Kalshi.
 *
 * Why this signal: replays of 2,800 games found nothing in our model, the
 * money flow, team ratings or order placement that beats Kalshi's price.
 * The live book line is the one lead left, and only a forward test can say
 * whether it holds (`buddy trading:lines`). These are paper bets: they
 * measure that test with stakes attached, and move no money.
 */

export interface SlatePick {
  line: LiveLine
  side: 'yes' | 'no'
  /** What the side costs now: the ask for YES, one minus the bid for NO. */
  price: number
  /** Book probability minus Kalshi's mid, for the side taken. */
  edge: number
  /** The book's probability for the side taken. */
  fair: number
  /**
   * Expected return per dollar if the book is right: what the side is worth,
   * less the price and Kalshi's fee, over the price. Below zero, the bet
   * loses money even when the book's line is the truth.
   */
  ev: number
  label: string
}

/** Kalshi's taker fee per contract at `price`, before rounding up the order total. */
function feePerContract(price: number): number {
  return 0.07 * price * (1 - price)
}

/** Expected return per dollar on a bet costing `price` that wins with probability `fair`, after fees. */
export function expectedReturn(fair: number, price: number): number {
  return Math.round(((fair - price - feePerContract(price)) / price) * 10000) / 10000
}

export interface Slate {
  singles: SlatePick[]
  parlays: SlatePick[][]
}

function label(line: LiveLine, side: 'yes' | 'no'): string {
  if (line.side === 'draw')
    return side === 'yes' ? `Draw (${line.title})` : `No draw (${line.title})`
  return side === 'yes' ? `${line.title} to win` : `${line.title} not to win`
}

/**
 * The best pick per game, highest expected return first. Ranked on what the
 * bet returns after crossing the spread and paying the fee, not on the raw
 * gap: a 1-point gap at the mid is a loss once both are paid.
 */
export function rankPicks(lines: LiveLine[], options: { minGap?: number } = {}): SlatePick[] {
  const minGap = options.minGap ?? 0.02
  const best = new Map<string, SlatePick>()
  for (const line of lines) {
    const mid = (line.bid + line.ask) / 2
    const gap = line.bookProb - mid
    if (Math.abs(gap) < minGap)
      continue
    const side = gap > 0 ? 'yes' : 'no'
    const price = side === 'yes' ? line.ask : Math.round((1 - line.bid) * 100) / 100
    if (!tradablePrice(price))
      continue
    const fair = side === 'yes' ? line.bookProb : 1 - line.bookProb
    const pick: SlatePick = {
      line,
      side,
      price,
      edge: Math.round(Math.abs(gap) * 10000) / 10000,
      fair: Math.round(fair * 10000) / 10000,
      ev: expectedReturn(fair, price),
      label: label(line, side),
    }
    const key = `${line.league}:${line.gameId}`
    const held = best.get(key)
    if (!held || pick.ev > held.ev)
      best.set(key, pick)
  }
  return [...best.values()].sort((a, b) => b.ev - a.ev)
}

/** Expected return per dollar of a parlay if the book is right on every leg. */
export function parlayExpectedReturn(legs: SlatePick[]): number {
  const fair = legs.reduce((product, pick) => product * pick.fair, 1)
  const price = legs.reduce((product, pick) => product * pick.price, 1)
  return expectedReturn(fair, price)
}

/**
 * Singles from the strongest picks, then two-leg parlays from the next ones.
 * Two legs only: with no proven edge every leg adds Kalshi's cut, so a longer
 * parlay compounds cost faster than it compounds payout. Legs always come
 * from different games. When there are too few picks for fresh legs, a
 * parlay reuses the singles' picks rather than reaching for weaker ones.
 */
export function buildSlate(picks: SlatePick[], options: { budget?: number, stake?: number, singles?: number } = {}): Slate {
  const stake = options.stake ?? 1
  const bets = Math.floor((options.budget ?? 5) / stake)
  const singles = picks.slice(0, Math.min(options.singles ?? 3, bets, picks.length))
  const parlayCount = Math.max(0, bets - singles.length)
  const pool = picks.length - singles.length >= parlayCount * 2 ? picks.slice(singles.length) : picks
  const parlays: SlatePick[][] = []
  for (let i = 0; i + 1 < pool.length && parlays.length < parlayCount; i += 2)
    parlays.push([pool[i]!, pool[i + 1]!])
  return { singles, parlays }
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`
}

function rationale(pick: SlatePick): string {
  const mid = (pick.line.bid + pick.line.ask) / 2
  const sideMid = pick.side === 'yes' ? mid : 1 - mid
  return `${pick.label}: ${pick.line.provider || 'Book'} ${pct(pick.fair)} vs Kalshi ${pct(sideMid)}, buying at ${Math.round(pick.price * 100)}¢, ${(pick.ev * 100).toFixed(1)}% expected if the book is right`
}

/** Read the live lines and build today's slate, without recording anything. */
export async function draftSlate(options: { budget?: number, stake?: number, singles?: number, windowMinutes?: number, minGap?: number } = {}): Promise<{ slate: Slate, picks: SlatePick[], lines: number }> {
  const lines = (await liveLines(undefined, options.windowMinutes ?? 12 * 60)).filter(line => line.minutes >= 20)
  const picks = rankPicks(lines, { minGap: options.minGap })
  return { slate: buildSlate(picks, options), picks, lines: lines.length }
}

/**
 * Record the slate as paper bets under its own paused paper strategy, so the
 * loop never trades it and its results stay apart from every other strategy.
 */
export async function placeSlate(db: Database, slate: Slate, options: { userId: number, stake?: number, name: string }): Promise<{ strategyId: number, singles: Array<{ label: string, placed: boolean, reason: string }>, parlays: number[] }> {
  const stake = options.stake ?? 1
  const now = new Date().toISOString()
  const budget = (slate.singles.length + slate.parlays.length) * stake
  const created = await db.query(`
    INSERT INTO trading_strategies (user_id, name, venue, mode, categories, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status, halted_reason, last_run_at, created_at, updated_at)
    VALUES (?, ?, 'kalshi', 'paper', '', ?, ?, 0.02, 0, 20, ?, ?, 0, 'paused', 'one-off paper slate', ?, ?, ?)
  `).run(options.userId, options.name, budget, stake, budget, budget, now, now, now)
  const strategyId = Number(created.lastInsertRowid)
  const row = await db.query<Record<string, unknown>>(`
    SELECT id, user_id, venue, mode, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status
    FROM trading_strategies WHERE id = ?
  `).get(strategyId)
  const strategy = normalizeStrategyRow(row as any)

  const singles: Array<{ label: string, placed: boolean, reason: string }> = []
  for (const pick of slate.singles) {
    const market = await db.query<{ id: number | string }>(`SELECT id FROM prediction_markets WHERE venue = 'kalshi' AND external_id = ? LIMIT 1`).get(pick.line.ticker)
    if (!market) {
      singles.push({ label: pick.label, placed: false, reason: 'market not in our database yet' })
      continue
    }
    const size = Math.floor(stake / pick.price)
    const mid = (pick.line.bid + pick.line.ask) / 2
    const sideMid = pick.side === 'yes' ? mid : 1 - mid
    const fair = pick.side === 'yes' ? pick.line.bookProb : 1 - pick.line.bookProb
    const decision = await db.query(`
      INSERT INTO trade_decisions (trading_strategy_id, prediction_market_id, venue, side, market_price, fair_value, edge, confidence,
        limit_price, size, notional, rationale, decided_by, status, status_reason, created_at, updated_at)
      VALUES (?, ?, 'kalshi', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'slate', 'approved', '', ?, ?)
    `).run(strategyId, Number(market.id), pick.side, Math.round(sideMid * 10000) / 10000, Math.round(fair * 10000) / 10000, pick.edge, pick.price, size, Math.round(size * pick.price * 100) / 100, rationale(pick), now, now)
    const [outcome] = await executePaper(db, strategy, [Number(decision.lastInsertRowid)])
    singles.push({ label: pick.label, placed: Boolean(outcome?.placed), reason: outcome?.reason ?? '' })
  }

  const parlays: number[] = []
  for (const legs of slate.parlays) {
    const paperLegs: PaperLeg[] = legs.map(pick => ({ ticker: pick.line.ticker, side: pick.side, price: pick.price, label: pick.label }))
    parlays.push(await placePaperParlay(db, { userId: options.userId, strategyId, stake, legs: paperLegs, rationale: legs.map(rationale).join(' · ') }))
  }

  return { strategyId, singles, parlays }
}
