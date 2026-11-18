import type { Database } from '../../Support/db'
import type { KalshiMarketInfo } from '../prediction-markets/kalshi-public'
import type { ParlayTracker } from './book-tracking'
import { kalshiMarkets } from '../prediction-markets/kalshi-public'
import { kalshiFee } from './backtest'
import { trackParlay } from './book-tracking'
import { settlePositions } from './positions'

/**
 * Paper parlays: simulated Kalshi parlays, priced from their legs and settled
 * from the legs' results. See `app/Models/PaperParlay.ts`.
 */

export interface PaperLeg {
  ticker: string
  side: 'yes' | 'no'
  /** What the leg cost on its own, 0..1. */
  price: number
  label: string
}

export interface PaperParlayRow {
  id: number
  user_id: number
  trading_strategy_id: number | null
  legs: PaperLeg[]
  stake: number
  price: number
  status: 'open' | 'won' | 'lost'
  payout: number
  rationale: string
  placed_at: string
  settled_at: string
}

/** The parlay's price: every leg must come in, so the legs' prices multiply. */
export function parlayPrice(legs: PaperLeg[]): number {
  return Math.round(legs.reduce((product, leg) => product * leg.price, 1) * 1_000_000) / 1_000_000
}

/** Payout of a winning parlay: stake ÷ price in $1 contracts, less Kalshi's fee. */
export function parlayPayout(stake: number, price: number): number {
  const contracts = stake / price
  return Math.round((contracts - kalshiFee(contracts, price)) * 100) / 100
}

export async function placePaperParlay(
  db: Database,
  parlay: { userId: number, strategyId: number | null, stake: number, legs: PaperLeg[], rationale?: string },
): Promise<number> {
  if (parlay.legs.length < 2)
    throw new Error('A parlay needs at least two legs')
  if (new Set(parlay.legs.map(leg => leg.ticker)).size !== parlay.legs.length)
    throw new Error('A parlay cannot hold the same market twice')
  const now = new Date().toISOString()
  const result = await db.query(`
    INSERT INTO paper_parlays (user_id, trading_strategy_id, legs, stake, price, status, payout, rationale, placed_at, settled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?, '', ?, ?)
  `).run(parlay.userId, parlay.strategyId, JSON.stringify(parlay.legs), parlay.stake, parlayPrice(parlay.legs), parlay.rationale ?? '', now, now, now)
  return Number(result.lastInsertRowid)
}

function toRow(raw: Record<string, unknown>): PaperParlayRow {
  return {
    id: Number(raw.id),
    user_id: Number(raw.user_id),
    trading_strategy_id: raw.trading_strategy_id === null ? null : Number(raw.trading_strategy_id),
    legs: JSON.parse(String(raw.legs || '[]')),
    stake: Number(raw.stake),
    price: Number(raw.price),
    status: String(raw.status) as PaperParlayRow['status'],
    payout: Number(raw.payout ?? 0),
    rationale: String(raw.rationale ?? ''),
    placed_at: String(raw.placed_at),
    settled_at: String(raw.settled_at ?? ''),
  }
}

export async function paperParlays(db: Database, userId: number, status?: 'open' | 'settled'): Promise<PaperParlayRow[]> {
  const where = status === 'open' ? `AND status = 'open'` : status === 'settled' ? `AND status <> 'open'` : ''
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM paper_parlays WHERE user_id = ? ${where} ORDER BY id DESC LIMIT 50`).all(userId)
  return rows.map(toRow)
}

/**
 * Settle every open paper parlay whose result is known: lost as soon as one
 * leg loses, won once every leg has won. Legs still open leave it open.
 */
export async function settlePaperParlays(
  db: Database,
  results: (tickers: string[]) => Promise<Map<string, string>> = legResults,
): Promise<{ settled: number, won: number, lost: number }> {
  const open = (await db.query<Record<string, unknown>>(`SELECT * FROM paper_parlays WHERE status = 'open'`).all()).map(toRow)
  if (open.length === 0)
    return { settled: 0, won: 0, lost: 0 }
  const known = await results([...new Set(open.flatMap(parlay => parlay.legs.map(leg => leg.ticker)))])
  let won = 0
  let lost = 0
  const now = new Date().toISOString()
  for (const parlay of open) {
    const outcomes = parlay.legs.map(leg => known.get(leg.ticker))
    const anyLost = parlay.legs.some((leg, i) => (outcomes[i] === 'yes' || outcomes[i] === 'no') && outcomes[i] !== leg.side)
    const allWon = parlay.legs.every((leg, i) => outcomes[i] === leg.side)
    if (!anyLost && !allWon)
      continue
    const payout = anyLost ? 0 : parlayPayout(parlay.stake, parlay.price)
    await db.query(`UPDATE paper_parlays SET status = ?, payout = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(anyLost ? 'lost' : 'won', payout, now, now, parlay.id)
    if (anyLost)
      lost++
    else won++
  }
  return { settled: won + lost, won, lost }
}

/**
 * Refresh the result of every Kalshi market an open position holds, then
 * settle what resolved. Ingestion refreshes unsettled markets oldest-first
 * and capped, across hundreds of thousands of rows, so a market a paper bet
 * holds could wait days for its result; this asks for exactly those.
 */
export async function settleHeldPositions(
  db: Database,
  results: (tickers: string[]) => Promise<Map<string, string>> = legResults,
): Promise<{ refreshed: number, settled: number }> {
  const held = await db.query<{ id: number | string, external_id: string }>(`
    SELECT DISTINCT m.id, m.external_id
    FROM exchange_positions p
    JOIN prediction_markets m ON m.id = p.prediction_market_id
    WHERE p.status = 'open' AND m.venue = 'kalshi' AND m.status != 'settled'
  `).all()
  if (held.length === 0)
    return { refreshed: 0, settled: 0 }
  const known = await results(held.map(row => row.external_id))
  const now = new Date().toISOString()
  let refreshed = 0
  for (const row of held) {
    const result = known.get(row.external_id)
    if (result !== 'yes' && result !== 'no')
      continue
    await db.query(`UPDATE prediction_markets SET status = 'settled', result = ?, updated_at = ? WHERE id = ?`).run(result, now, Number(row.id))
    refreshed++
  }
  const summary = refreshed > 0 ? await settlePositions(db) : { settled: 0 }
  return { refreshed, settled: summary.settled }
}

async function legResults(tickers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < tickers.length; i += 100) {
    const markets = await kalshiMarkets(tickers.slice(i, i + 100), 30_000).catch(() => new Map<string, KalshiMarketInfo>())
    for (const [ticker, market] of markets) out.set(ticker, market.result)
  }
  return out
}

/** The live view the positions page draws for a parlay, from its legs. */
export async function trackPaperParlay(parlay: PaperParlayRow): Promise<ParlayTracker | null> {
  return await trackParlay({
    ticker: `paper-parlay-${parlay.id}`,
    eventTicker: '',
    title: parlay.legs.map(leg => leg.label).join(' · '),
    yesSubTitle: '',
    noSubTitle: '',
    status: 'open',
    result: '',
    openTime: parlay.placed_at,
    closeTime: '',
    occursAt: '',
    lastPrice: null,
    yesBid: null,
    yesAsk: null,
    volume: 0,
    legs: parlay.legs.map(leg => ({ eventTicker: '', marketTicker: leg.ticker, side: leg.side })),
  }).catch(() => null)
}
