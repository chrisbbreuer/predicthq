import type { KalshiCandle, KalshiTrade } from '../prediction-markets/kalshi-public'
import type { Candidate, MarketDatabaseRow } from './evidence'
import type { LiveGame } from './live-games'
import { Database as Sqlite } from 'bun:sqlite'
import { Database } from '../../Support/db'
import { kalshiCandles, kalshiSettledMarkets, kalshiTrades } from '../prediction-markets/kalshi-public'
import { evaluateMarketAt } from './evidence'
import { liveGameFor, parseGameTicker } from './live-games'

/**
 * Replay a finished day of games and score how each way of betting would
 * have done, using only what was knowable at each moment.
 *
 * For every settled Kalshi winner market on the date, the market is read
 * at a few checkpoints (shortly before the start, then a quarter, half, and
 * three quarters of the way to the moment the price settled the question).
 * At each checkpoint:
 *
 *   - the market's own price is the baseline forecast;
 *   - the evidence engine is replayed with `asOf` set to that moment, so it
 *     reads only trades from before it. The trades come from Kalshi's public
 *     tape, loaded into a throwaway in-memory database, so a replay never
 *     depends on what our own ingestion happened to capture;
 *   - a handful of plain strategies decide whether to bet.
 *
 * Bets are filled at the quote that was resting then (the ask for the side
 * bought, not the midpoint) and pay Kalshi's taker fee, so a strategy only
 * looks good here if it would have beaten the spread and the fee too.
 *
 * Two-team events list one market per team, mirror images of each other;
 * only one market per event is scored so a single game is never counted
 * twice. Nothing here writes to our database or contacts an account.
 */

export interface BacktestOptions {
  /** Eastern date of the games, `YYYYMMDD`. */
  date: string
  /** Dollars per bet. */
  stake?: number
  /** Starting bankroll for the sequential simulation. */
  bankroll?: number
  /** Minimum model edge (probability points) before the model bets. */
  minEdge?: number
  /** Cap on events, to keep a run inside the venue's rate limits. */
  maxEvents?: number
  /** Series prefixes to include. */
  series?: string[]
  /** Progress callback for long runs. */
  onProgress?: (done: number, total: number) => void
}

export interface BacktestBet {
  strategy: string
  ticker: string
  label: string
  checkpoint: string
  at: number
  side: 'yes' | 'no'
  price: number
  stake: number
  fee: number
  won: boolean
  pnl: number
  /** The market's midpoint at the time. */
  mid: number
  /** The model's YES probability, when it had a view. */
  fair: number | null
}

/** What the model thought at one checkpoint, bet or not, for signal analysis. */
export interface ModelView {
  ticker: string
  checkpoint: string
  inPlay: boolean
  mid: number
  /** The model's YES probability. */
  fair: number
  confidence: number
  outcome: 0 | 1
  /** Each signal's contribution, signed towards YES. */
  signals: Record<string, number>
}

export interface StrategyResult {
  strategy: string
  bets: number
  wins: number
  staked: number
  fees: number
  pnl: number
  roi: number | null
  /** Bankroll after betting `stake` on each signal in time order. */
  endingBankroll: number
}

export interface BacktestReport {
  date: string
  events: number
  checkpoints: number
  /** Mean squared error of each forecast against the outcome; lower is better. */
  brier: { market: number | null, model: number | null, modelViews: number }
  strategies: StrategyResult[]
  bets: BacktestBet[]
  views: ModelView[]
  skipped: Record<string, number>
}

const DEFAULT_SERIES = ['KXNBAGAME', 'KXNFLGAME', 'KXNCAAFGAME', 'KXNCAAMBGAME', 'KXNCAAWBGAME', 'KXNHLGAME', 'KXWNBAGAME', 'KXMLBGAME']

/** Kalshi's taker fee for `contracts` at `price`, rounded up to the cent. */
export function kalshiFee(contracts: number, price: number): number {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100 - 1e-9) / 100
}

/** Settle one bet: `stake` buys `stake / price` contracts paying $1 each. */
export function settleBet(stake: number, price: number, won: boolean): { fee: number, pnl: number } {
  const contracts = stake / price
  const fee = kalshiFee(contracts, price)
  const pnl = (won ? contracts - stake : -stake) - fee
  return { fee, pnl: Math.round(pnl * 100) / 100 }
}

interface PricePoint { ts: number, mid: number, bid: number | null, ask: number | null }

function pricePath(candles: KalshiCandle[]): PricePoint[] {
  const path: PricePoint[] = []
  let last: number | null = null
  for (const candle of candles) {
    let mid: number | null = null
    if (candle.bid !== null && candle.ask !== null && candle.ask > 0 && candle.ask - candle.bid <= 0.1)
      mid = (candle.bid + candle.ask) / 2
    else if (candle.close !== null)
      mid = candle.close
    if (mid === null)
      mid = last
    if (mid === null)
      continue
    last = mid
    path.push({ ts: candle.ts, mid, bid: candle.bid, ask: candle.ask })
  }
  return path
}

function pointAt(path: PricePoint[], ts: number): PricePoint | null {
  let found: PricePoint | null = null
  for (const point of path) {
    if (point.ts > ts)
      break
    found = point
  }
  return found
}

/** The first moment the price all but settled the question. */
function decidedAt(path: PricePoint[], after: number): number | null {
  for (const point of path) {
    if (point.ts > after && (point.mid >= 0.97 || point.mid <= 0.03))
      return point.ts
  }
  return null
}

/** What it costs to buy one side at a point: the ask, or a cent over the mid. */
function costOf(point: PricePoint, side: 'yes' | 'no'): number {
  if (side === 'yes')
    return point.ask !== null && point.ask > 0 ? point.ask : Math.min(0.99, point.mid + 0.01)
  return point.bid !== null && point.bid > 0 ? 1 - point.bid : Math.min(0.99, 1 - point.mid + 0.01)
}

function gameAt(game: LiveGame | null, ts: number, startsAt: number): LiveGame | null {
  if (!game)
    return null
  // The engine only reads the state and start time; the score it would
  // have seen is not reconstructable, so it is left out rather than leaked.
  return { ...game, state: ts < startsAt ? 'pre' : 'in', status: '', home: { ...game.home, score: null }, away: { ...game.away, score: null } }
}

export async function backtestGames(options: BacktestOptions): Promise<BacktestReport> {
  const stake = options.stake ?? 1
  const bankroll = options.bankroll ?? 10
  const minEdge = options.minEdge ?? 0.03
  const series = options.series ?? DEFAULT_SERIES
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }

  const yymmdd = `${options.date.slice(2, 4)}${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(options.date.slice(4, 6)) - 1]}${options.date.slice(6, 8)}`
  // A day's games close between that morning and two days later at most.
  const dayStart = Date.UTC(Number(options.date.slice(0, 4)), Number(options.date.slice(4, 6)) - 1, Number(options.date.slice(6, 8))) / 1000
  const rows: Array<MarketDatabaseRow & { result: string }> = []
  for (const prefix of series) {
    const markets = await kalshiSettledMarkets(prefix, dayStart, dayStart + 2 * 86_400).catch(() => [])
    for (const market of markets) {
      if (!market.ticker.startsWith(`${prefix}-${yymmdd}`))
        continue
      rows.push({
        id: rows.length + 1,
        venue: 'kalshi',
        external_id: market.ticker,
        question: market.title,
        outcome_label: market.yesSubTitle,
        category: 'sports',
        last_price: market.lastPrice ?? 0,
        liquidity: 0,
        result: market.result,
      })
    }
  }
  rows.sort((a, b) => a.external_id.localeCompare(b.external_id))

  // One market per event: the alphabetically first outcome.
  const byEvent = new Map<string, MarketDatabaseRow & { result: string }>()
  for (const row of rows) {
    const ref = parseGameTicker(row.external_id)
    if (!ref?.winner) {
      skip('not a winner market')
      continue
    }
    if (/-TIE$/i.test(row.external_id) || byEvent.has(ref.eventTicker))
      continue
    if (row.result !== 'yes' && row.result !== 'no') {
      skip('not settled')
      continue
    }
    byEvent.set(ref.eventTicker, row)
  }
  const events = [...byEvent.values()].slice(0, options.maxEvents ?? 400)

  const bets: BacktestBet[] = []
  const views: ModelView[] = []
  const brierMarket: number[] = []
  const brierModel: number[] = []
  let modelViews = 0
  let checkpoints = 0
  let done = 0

  for (const row of events) {
    done++
    options.onProgress?.(done, events.length)
    const ref = parseGameTicker(row.external_id)!
    const outcome = row.result === 'yes' ? 1 : 0
    const game = await liveGameFor(row.external_id, 'yes').catch(() => null)
    const startsAt = game ? Math.floor(Date.parse(game.startsAt) / 1000) : Number.NaN
    if (!Number.isFinite(startsAt)) {
      skip('no game time')
      continue
    }

    const candles = await kalshiCandles(ref.eventTicker, row.external_id, startsAt - 3 * 3600, startsAt + 6 * 3600, 1, 600_000)
      .catch(() => [] as KalshiCandle[])
    const path = pricePath(candles)
    const decided = decidedAt(path, startsAt)
    if (path.length < 10 || !decided) {
      skip(path.length < 10 ? 'no price history' : 'never decided in window')
      continue
    }

    // The engine's window reaches a day back from the earliest checkpoint.
    const trades = await kalshiTrades(row.external_id, startsAt - 30 * 60 - 25 * 3600, decided).catch(() => null)
    if (!trades) {
      skip('no trade tape')
      continue
    }
    const tape = tapeDatabase(Number(row.id), trades)

    const span = decided - startsAt
    const marks: Array<[string, number]> = [
      ['pre-game', startsAt - 30 * 60],
      ['25%', startsAt + span * 0.25],
      ['50%', startsAt + span * 0.5],
      ['75%', startsAt + span * 0.75],
    ]

    for (const [checkpoint, ts] of marks) {
      const point = pointAt(path, ts)
      if (!point || point.mid <= 0.02 || point.mid >= 0.98) {
        skip('no tradable price at checkpoint')
        continue
      }
      checkpoints++
      brierMarket.push((point.mid - outcome) ** 2)

      let candidate: Candidate | null = null
      try {
        candidate = await evaluateMarketAt(tape.db, row, { asOf: ts * 1000, yesPriceAt: point.mid, game: gameAt(game, ts, startsAt) })
      }
      catch {
        candidate = null
      }
      const modelYes = candidate ? (candidate.side === 'yes' ? candidate.fairValue : 1 - candidate.fairValue) : point.mid
      if (candidate) {
        modelViews++
        const towardsYes = candidate.side === 'yes' ? 1 : -1
        views.push({
          ticker: row.external_id,
          checkpoint,
          inPlay: checkpoint !== 'pre-game',
          mid: Math.round(point.mid * 1000) / 1000,
          fair: Math.round(modelYes * 1000) / 1000,
          confidence: candidate.confidence,
          outcome,
          signals: Object.fromEntries(candidate.evidence.map(item => [item.kind, Math.round(item.contribution * towardsYes * 10000) / 10000])),
        })
      }
      brierModel.push((modelYes - outcome) ** 2)

      const place = (strategy: string, side: 'yes' | 'no') => {
        const price = costOf(point, side)
        if (price <= 0.01 || price >= 0.99)
          return
        const won = side === 'yes' ? outcome === 1 : outcome === 0
        const { fee, pnl } = settleBet(stake, price, won)
        bets.push({ strategy, ticker: row.external_id, label: row.outcome_label || row.question, checkpoint, at: ts, side, price: Math.round(price * 1000) / 1000, stake, fee, won, pnl, mid: Math.round(point.mid * 1000) / 1000, fair: candidate ? Math.round(modelYes * 1000) / 1000 : null })
      }

      // The model, only where it disagrees with the market by enough.
      // Split by phase and by size of disagreement, to see where it helps.
      const edge = Math.abs(modelYes - point.mid)
      if (candidate && edge >= minEdge) {
        const side = modelYes > point.mid ? 'yes' : 'no'
        place('model', side)
        place(checkpoint === 'pre-game' ? 'model-pre' : 'model-live', side)
        if (edge >= 0.08)
          place('model-8pt', side)
      }

      // Plain baselines, to tell skill from luck.
      place('favorite', point.mid >= 0.5 ? 'yes' : 'no')
      place('underdog', point.mid >= 0.5 ? 'no' : 'yes')

      // Momentum over the previous fifteen minutes, in play only.
      if (checkpoint !== 'pre-game') {
        const before = pointAt(path, ts - 15 * 60)
        const move = before ? point.mid - before.mid : 0
        if (Math.abs(move) >= 0.08) {
          place('momentum', move > 0 ? 'yes' : 'no')
          place('fade', move > 0 ? 'no' : 'yes')
        }
      }
    }
    tape.close()
  }

  const strategies = summarizeBets(bets, bankroll)

  const mean = (values: number[]) => values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10000) / 10000 : null
  return {
    date: options.date,
    events: events.length,
    checkpoints,
    brier: { market: mean(brierMarket), model: mean(brierModel), modelViews },
    strategies,
    bets,
    views,
    skipped,
  }
}

/**
 * Score each strategy's bets: totals, plus a bankroll that starts at
 * `bankroll` and takes every bet in time order until it can no longer
 * cover a stake.
 */
export function summarizeBets(bets: BacktestBet[], bankroll: number): StrategyResult[] {
  return [...new Set(bets.map(bet => bet.strategy))].map((strategy): StrategyResult => {
    const mine = bets.filter(bet => bet.strategy === strategy).sort((a, b) => a.at - b.at)
    let bank = bankroll
    for (const bet of mine) {
      if (bank < bet.stake)
        break
      bank += bet.pnl
    }
    const staked = mine.reduce((sum, bet) => sum + bet.stake, 0)
    const pnl = mine.reduce((sum, bet) => sum + bet.pnl, 0)
    return {
      strategy,
      bets: mine.length,
      wins: mine.filter(bet => bet.won).length,
      staked: Math.round(staked * 100) / 100,
      fees: Math.round(mine.reduce((sum, bet) => sum + bet.fee, 0) * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      roi: staked > 0 ? Math.round((pnl / staked) * 1000) / 1000 : null,
      endingBankroll: Math.round(bank * 100) / 100,
    }
  }).sort((a, b) => b.pnl - a.pnl)
}

/** SQLite's form of a timestamp, matching how the app stores and binds them. */
function sqlTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * A throwaway in-memory database holding one market's tape, shaped like
 * the tables the evidence engine reads, so the replay runs the very same
 * queries production does.
 */
export function tapeDatabase(marketId: number, trades: KalshiTrade[]): { db: Database, close: () => void } {
  const sqlite = new Sqlite(':memory:')
  sqlite.run(`CREATE TABLE market_traders (id INTEGER PRIMARY KEY, smart_score REAL)`)
  sqlite.run(`CREATE TABLE market_trades (
    id INTEGER PRIMARY KEY, prediction_market_id INTEGER, market_trader_id INTEGER, side TEXT,
    price REAL, size REAL, notional REAL, is_winner INTEGER, traded_at TEXT
  )`)
  sqlite.run(`CREATE INDEX market_trades_market_traded_at ON market_trades (prediction_market_id, traded_at)`)
  const insert = sqlite.prepare(`INSERT INTO market_trades (prediction_market_id, market_trader_id, side, price, size, notional, is_winner, traded_at) VALUES (?, NULL, ?, ?, ?, ?, -1, ?)`)
  sqlite.transaction(() => {
    for (const trade of trades)
      insert.run(marketId, trade.side, trade.price, trade.size, Math.round(trade.size * trade.price * 100) / 100, sqlTime(trade.at))
  })()
  const executor = {
    unsafe: (query: string, params: unknown[] = []) => ({
      execute: async () => sqlite.query(query).all(...(params as Array<string | number | null>)),
    }),
  }
  return { db: new Database(executor), close: () => sqlite.close() }
}
