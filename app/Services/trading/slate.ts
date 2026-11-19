import type { Database } from '../../Support/db'
import type { LiveLine } from './line-snapshots'
import type { PaperLeg } from './paper-parlays'
import { tradablePrice } from './evidence'
import { liveLines } from './line-snapshots'
import { executePaper } from './paper'
import { parlayPayout, placePaperParlay } from './paper-parlays'
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

/** Leagues where a game can end level, so NO on one side is not a bet on the other. */
const SOCCER = new Set(['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uefa-nations', 'mls'])

function label(line: LiveLine, side: 'yes' | 'no'): string {
  if (line.prop)
    return side === 'yes' ? line.title : `Under: ${line.title}`
  if (line.side === 'draw')
    return side === 'yes' ? `Draw (${line.title})` : `No draw (${line.title})`
  if (side === 'yes')
    return `${line.title} to win`
  // Outside soccer a game has no draw, so NO on one team is the other team
  // winning, bought on this team's market: say who the bet is on.
  if (line.opponent && !SOCCER.has(line.league))
    return `${line.opponent} to win (NO on ${line.title})`
  return `${line.title} not to win`
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
    // In play there is no book to disagree with: back the side the market
    // favours now, the likelier leg, and let its cost show in `ev`.
    if (!line.live && Math.abs(gap) < minGap)
      continue
    const side = line.live ? (mid >= 0.5 ? 'yes' : 'no') : (gap > 0 ? 'yes' : 'no')
    const pick = pickFor(line, side)
    if (!pick)
      continue
    const key = `${line.league}:${line.gameId}`
    const held = best.get(key)
    if (!held || pick.ev > held.ev)
      best.set(key, pick)
  }
  return [...best.values()].sort((a, b) => b.ev - a.ev)
}

/** A pick on `side` of one market, or null when that side is outside the tradable band. */
export function pickFor(line: LiveLine, side: 'yes' | 'no'): SlatePick | null {
  const mid = (line.bid + line.ask) / 2
  const price = side === 'yes' ? line.ask : Math.round((1 - line.bid) * 100) / 100
  if (!tradablePrice(price))
    return null
  const fair = side === 'yes' ? line.bookProb : 1 - line.bookProb
  return {
    line,
    side,
    price,
    edge: Math.round(Math.abs(line.bookProb - mid) * 10000) / 10000,
    fair: Math.round(fair * 10000) / 10000,
    ev: expectedReturn(fair, price),
    label: label(line, side) + (line.live ? ' (live)' : ''),
  }
}

/**
 * Explicit picks, written `TICKER:side` (side defaults to yes), resolved
 * against the live lines. Unknown tickers and untradable prices are dropped.
 */
export function explicitPicks(lines: LiveLine[], specs: string[]): SlatePick[] {
  const byTicker = new Map(lines.map(line => [line.ticker, line]))
  return specs.flatMap((spec) => {
    const [ticker = '', rawSide = 'yes'] = spec.trim().split(':')
    const line = byTicker.get(ticker)
    const side = rawSide.toLowerCase() === 'no' ? 'no' : 'yes'
    const pick = line ? pickFor(line, side) : null
    return pick ? [pick] : []
  })
}

/** Expected return per dollar of a parlay if the book is right on every leg. */
export function parlayExpectedReturn(legs: SlatePick[]): number {
  const fair = legs.reduce((product, pick) => product * pick.fair, 1)
  const price = legs.reduce((product, pick) => product * pick.price, 1)
  return expectedReturn(fair, price)
}

/** A parlay should pay at least this many times its stake. */
export const MIN_PARLAY_PAYOUT = 2

/** The longest parlay assembled automatically: every leg adds Kalshi's cut. */
export const MAX_PARLAY_LEGS = 4

/**
 * One parlay from `pool`, in its order (strongest first), adding legs from
 * different games until it pays at least `minPayout` times the stake (its
 * price is at most 1 ÷ minPayout). Null when that takes more than
 * `maxLegs` legs. Picks are taken from `pool` without reordering it.
 */
export function assembleParlay(
  pool: SlatePick[],
  options: { minPayout?: number, maxLegs?: number, start?: SlatePick[], stake?: number } = {},
): SlatePick[] | null {
  const minPayout = options.minPayout ?? MIN_PARLAY_PAYOUT
  const stake = options.stake ?? 1
  const meetsPayout = (price: number) => parlayPayout(stake, price) >= minPayout * stake
  const maxLegs = options.maxLegs ?? MAX_PARLAY_LEGS
  const legs = [...(options.start ?? [])]
  const games = new Set(legs.map(pick => `${pick.line.league}:${pick.line.gameId}`))
  const price = () => legs.reduce((product, pick) => product * pick.price, 1)
  for (const pick of pool) {
    if (legs.length >= 2 && meetsPayout(price()))
      break
    if (legs.length >= maxLegs)
      return null
    const game = `${pick.line.league}:${pick.line.gameId}`
    if (games.has(game))
      continue
    legs.push(pick)
    games.add(game)
  }
  return legs.length >= 2 && meetsPayout(price()) ? legs : null
}

/**
 * Singles from the strongest picks, then parlays from the next ones, each
 * built to pay at least 2× (see `assembleParlay`): two legs when their
 * prices allow, more when they are favourites. Legs come from different
 * games, and no pick is used in two parlays. When too few picks remain after
 * the singles, parlays draw on the singles' picks too rather than on weaker
 * ones.
 */
export function buildSlate(picks: SlatePick[], options: { budget?: number, stake?: number, singles?: number } = {}): Slate {
  const stake = options.stake ?? 1
  const bets = Math.floor((options.budget ?? 5) / stake)
  const singles = picks.slice(0, Math.min(options.singles ?? 3, bets, picks.length))
  const parlayCount = Math.max(0, bets - singles.length)
  const parlays: SlatePick[][] = []
  for (const source of [picks.slice(singles.length), picks]) {
    let pool = source.filter(pick => !parlays.flat().includes(pick))
    while (parlays.length < parlayCount) {
      const parlay = assembleParlay(pool, { stake })
      if (!parlay)
        break
      parlays.push(parlay)
      pool = pool.filter(pick => !parlay.includes(pick))
    }
  }
  return { singles, parlays }
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`
}

function rationale(pick: SlatePick): string {
  const mid = (pick.line.bid + pick.line.ask) / 2
  const sideMid = pick.side === 'yes' ? mid : 1 - mid
  if (pick.line.prop || pick.line.live)
    return `${pick.label}: Kalshi has it at ${pct(sideMid)}, buying at ${Math.round(pick.price * 100)}¢. No edge claimed; spread and fee cost about ${(-pick.ev * 100).toFixed(1)}%`
  return `${pick.label}: ${pick.line.provider || 'Book'} ${pct(pick.fair)} vs Kalshi ${pct(sideMid)}, buying at ${Math.round(pick.price * 100)}¢, ${(pick.ev * 100).toFixed(1)}% expected if the book is right`
}

/** Read the live lines and build today's slate, without recording anything. */
export async function draftSlate(options: { budget?: number, stake?: number, singles?: number, windowMinutes?: number, minGap?: number } = {}): Promise<{ slate: Slate, picks: SlatePick[], lines: number }> {
  const lines = (await liveLines(undefined, options.windowMinutes ?? 12 * 60)).filter(line => line.minutes >= 20)
  const picks = rankPicks(lines, { minGap: options.minGap })
  return { slate: buildSlate(picks, options), picks, lines: lines.length }
}

/**
 * The market's row, created from the live quote when ingestion has not seen
 * it trade yet. Its result is filled in later by the settle job, which asks
 * Kalshi about every market a paper position holds.
 */
async function ensureMarket(db: Database, market: { ticker: string, title: string, startsAt: string }, mid: number, now: string): Promise<number> {
  const existing = await db.query<{ id: number | string }>(`SELECT id FROM prediction_markets WHERE venue = 'kalshi' AND external_id = ? LIMIT 1`).get(market.ticker)
  if (existing)
    return Number(existing.id)
  const created = await db.query(`
    INSERT INTO prediction_markets (venue, external_id, question, outcome_label, category, status, result, volume, liquidity, last_price, ends_at, created_at, updated_at)
    VALUES ('kalshi', ?, ?, ?, 'Sports', 'open', '', 0, 0, ?, ?, ?, ?)
  `).run(market.ticker, `${market.title} to win`, market.title, Math.round(mid * 10000) / 10000, market.startsAt, now, now)
  return Number(created.lastInsertRowid)
}

/** A pick as the stored leg a single or a suggestion carries. */
export function pickLeg(pick: SlatePick): { ticker: string, title: string, startsAt: string, side: 'yes' | 'no', price: number, fair: number, yesMid: number, edge: number, rationale: string, label: string, live: boolean, ev: number } {
  return {
    ticker: pick.line.ticker,
    title: pick.line.title,
    startsAt: pick.line.startsAt,
    side: pick.side,
    price: pick.price,
    fair: pick.fair,
    yesMid: Math.round(((pick.line.bid + pick.line.ask) / 2) * 10000) / 10000,
    edge: pick.edge,
    rationale: rationale(pick),
    label: pick.label,
    live: pick.line.live,
    ev: pick.ev,
  }
}

/** A paused paper strategy of the user's with this name, created on first use. */
export async function ensurePaperStrategy(db: Database, userId: number, name: string, budget: number, stake: number): Promise<number> {
  const existing = await db.query<{ id: number | string }>(`SELECT id FROM trading_strategies WHERE user_id = ? AND name = ? AND mode = 'paper' LIMIT 1`).get(userId, name)
  if (existing)
    return Number(existing.id)
  const now = new Date().toISOString()
  const created = await db.query(`
    INSERT INTO trading_strategies (user_id, name, venue, mode, categories, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status, halted_reason, last_run_at, created_at, updated_at)
    VALUES (?, ?, 'kalshi', 'paper', '', ?, ?, 0.02, 0, 50, ?, ?, 0, 'paused', 'paper bets placed by hand', ?, ?, ?)
  `).run(userId, name, budget, stake, budget, budget, now, now, now)
  return Number(created.lastInsertRowid)
}

/** One paper single at the leg's price, through the same engine every paper order uses. */
export async function placePaperSingle(
  db: Database,
  strategyId: number,
  leg: { ticker: string, title: string, startsAt: string, side: 'yes' | 'no', price: number, fair: number, yesMid: number, edge: number, rationale: string },
  stake: number,
): Promise<{ placed: boolean, reason: string }> {
  const now = new Date().toISOString()
  const row = await db.query<Record<string, unknown>>(`
    SELECT id, user_id, venue, mode, bankroll, max_stake, min_edge, min_confidence,
      max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status
    FROM trading_strategies WHERE id = ?
  `).get(strategyId)
  const strategy = normalizeStrategyRow(row as any)
  const marketId = await ensureMarket(db, leg, leg.yesMid, now)
  const size = Math.floor(stake / leg.price)
  if (size < 1)
    return { placed: false, reason: 'stake below one contract' }
  const sideMid = leg.side === 'yes' ? leg.yesMid : 1 - leg.yesMid
  const decision = await db.query(`
    INSERT INTO trade_decisions (trading_strategy_id, prediction_market_id, venue, side, market_price, fair_value, edge, confidence,
      limit_price, size, notional, rationale, decided_by, status, status_reason, created_at, updated_at)
    VALUES (?, ?, 'kalshi', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'slate', 'approved', '', ?, ?)
  `).run(strategyId, marketId, leg.side, Math.round(sideMid * 10000) / 10000, Math.round(leg.fair * 10000) / 10000, leg.edge, leg.price, size, Math.round(size * leg.price * 100) / 100, leg.rationale, now, now)
  const [outcome] = await executePaper(db, strategy, [Number(decision.lastInsertRowid)])
  return { placed: Boolean(outcome?.placed), reason: outcome?.reason ?? '' }
}

/**
 * Record the slate as paper bets under its own paused paper strategy, so the
 * loop never trades it and its results stay apart from every other strategy.
 */
export async function placeSlate(db: Database, slate: Slate, options: { userId: number, stake?: number, name: string, strategyId?: number }): Promise<{ strategyId: number, singles: Array<{ label: string, placed: boolean, reason: string }>, parlays: number[] }> {
  const stake = options.stake ?? 1
  const now = new Date().toISOString()
  const budget = (slate.singles.length + slate.parlays.length) * stake
  let strategyId = options.strategyId ?? 0
  if (!strategyId) {
    const created = await db.query(`
      INSERT INTO trading_strategies (user_id, name, venue, mode, categories, bankroll, max_stake, min_edge, min_confidence,
        max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status, halted_reason, last_run_at, created_at, updated_at)
      VALUES (?, ?, 'kalshi', 'paper', '', ?, ?, 0.02, 0, 20, ?, ?, 0, 'paused', 'one-off paper slate', ?, ?, ?)
    `).run(options.userId, options.name, budget, stake, budget, budget, now, now, now)
    strategyId = Number(created.lastInsertRowid)
  }
  const singles: Array<{ label: string, placed: boolean, reason: string }> = []
  for (const pick of slate.singles) {
    const outcome = await placePaperSingle(db, strategyId, pickLeg(pick), stake)
    singles.push({ label: pick.label, ...outcome })
  }

  const parlays: number[] = []
  for (const legs of slate.parlays) {
    const paperLegs: PaperLeg[] = legs.map(pick => ({ ticker: pick.line.ticker, side: pick.side, price: pick.price, label: pick.label }))
    parlays.push(await placePaperParlay(db, { userId: options.userId, strategyId, stake, legs: paperLegs, rationale: legs.map(rationale).join(' · ') }))
  }

  return { strategyId, singles, parlays }
}
