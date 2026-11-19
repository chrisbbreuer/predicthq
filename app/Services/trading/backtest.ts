import type { KalshiCandle, KalshiTrade } from '../prediction-markets/kalshi-public'
import type { Candidate, MarketDatabaseRow } from './evidence'
import type { LiveGame } from './live-games'
import type { SportsbookForecast } from './sportsbook-consensus'
import { Database as Sqlite } from 'bun:sqlite'
import { Database } from '../../Support/db'
import { kalshiCandles, kalshiSettledMarkets, kalshiTrades } from '../prediction-markets/kalshi-public'
import { evaluateMarketAt, tradablePrice } from './evidence'
import { liveGameFor, parseGameTicker } from './live-games'
import { sportsbookConsensus } from './sportsbook-consensus'

/**
 * Replay a finished day of games and score how each way of betting would
 * have done, using only what was knowable at each moment.
 *
 * For every settled Kalshi winner market on the date, the market is read
 * at fixed offsets from the scheduled start (-30, +30, +60 and +90 minutes).
 * At each checkpoint:
 *
 *   - the market's own price is the baseline forecast;
 *   - the evidence engine is replayed with `asOf` set to that moment, so it
 *     reads only trades from before it. The trades come from Kalshi's public
 *     tape, loaded into a throwaway in-memory database, so a replay never
 *     depends on what our own ingestion happened to capture;
 *   - a handful of plain strategies decide whether to bet.
 *
 * Paper fills use the quoted ask (or one minus the YES bid for NO) and
 * pay the taker fee. Candles do not provide executable size, so this
 * estimates prices without claiming a live order would have filled.
 *
 * Two-team events list one market per team, mirror images of each other;
 * only one market per event is scored so a single game is never counted
 * twice. Nothing here writes to our database or contacts an account.
 */

export interface BacktestOptions {
  /** Optional historical odds database for a paired pre-game sportsbook benchmark. */
  consensusDb?: Database
  /** Eastern date of the games, `YYYYMMDD`. */
  date: string
  /** Dollars per bet. */
  stake?: number
  /** Starting bankroll for the sequential simulation. */
  bankroll?: number
  /** Minimum model edge (probability points) before the model bets. */
  minEdge?: number
  /** Confidence floor for the `rules` strategies, as the live strategy applies it. */
  minConfidence?: number
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

export interface ConsensusView {
  ticker: string
  at: number
  market: number
  sportsbook: number
  books: string[]
  outcome: 0 | 1
}

export function summarizeConsensus(views: ConsensusView[]) {
  const summarize = (forecast: (row: ConsensusView) => number) => {
    if (views.length === 0)
      return { brier: null, logLoss: null }
    let brier = 0
    let logLoss = 0
    for (const row of views) {
      const p = forecast(row)
      brier += (p - row.outcome) ** 2
      logLoss -= Math.log(Math.max(1e-9, row.outcome ? p : 1 - p))
    }
    return { brier: brier / views.length, logLoss: logLoss / views.length }
  }
  return {
    sampleSize: views.length,
    market: summarize(row => row.market),
    sportsbook: summarize(row => row.sportsbook),
    blend: summarize(row => (row.market + row.sportsbook) / 2),
  }
}

export interface BacktestReport {
  date: string
  events: number
  checkpoints: number
  /** Mean squared error of each forecast against the outcome; lower is better. */
  brier: { market: number | null, model: number | null, modelViews: number }
  consensus?: ReturnType<typeof summarizeConsensus>
  consensusViews: ConsensusView[]
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

interface PricePoint { ts: number, mid: number, bid: number, ask: number }

const CHECKPOINTS = [
  ['pre-game', -30],
  ['+30m', 30],
  ['+60m', 60],
  ['+90m', 90],
] as const
const MAX_QUOTE_AGE_SECONDS = 60

/** Use the latest completed candle. A missing side on that candle means no quote. */
export function quoteAt(candles: KalshiCandle[], ts: number): PricePoint | null {
  let found: KalshiCandle | undefined
  for (const candle of candles) {
    if (candle.ts <= ts && (!found || candle.ts > found.ts))
      found = candle
  }
  if (!found || ts - found.ts > MAX_QUOTE_AGE_SECONDS)
    return null
  const { bid, ask } = found
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask >= 1 || ask < bid || ask - bid > 0.100000001)
    return null
  return { ts: found.ts, mid: (bid + ask) / 2, bid, ask }
}

function costOf(point: PricePoint, side: 'yes' | 'no'): number {
  return side === 'yes' ? point.ask : 1 - point.bid
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
  const minConfidence = options.minConfidence ?? 0.6
  const series = options.series ?? DEFAULT_SERIES
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }

  const yymmdd = `${options.date.slice(2, 4)}${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(options.date.slice(4, 6)) - 1]}${options.date.slice(6, 8)}`
  // Include games whose scheduled market close is several days after tip-off.
  const dayStart = Date.UTC(Number(options.date.slice(0, 4)), Number(options.date.slice(4, 6)) - 1, Number(options.date.slice(6, 8))) / 1000
  type SettledRow = MarketDatabaseRow & { result: string, openedAt: number, closedAt: number }
  const rows: SettledRow[] = []
  for (const prefix of series) {
    const markets = await kalshiSettledMarkets(prefix, dayStart, dayStart + 4 * 86_400).catch(() => {
      skip('market listing unavailable')
      return []
    })
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
        openedAt: Date.parse(market.openTime) / 1000,
        closedAt: Math.min(...[market.closeTime, market.settledAt ?? ''].map(Date.parse).filter(Number.isFinite)) / 1000,
      })
    }
  }
  rows.sort((a, b) => a.external_id.localeCompare(b.external_id))

  // One market per event: the alphabetically first outcome.
  const byEvent = new Map<string, SettledRow>()
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
  const consensusViews: ConsensusView[] = []
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

    if (!Number.isFinite(row.closedAt)) {
      skip('no market close time')
      continue
    }
    const first = startsAt + CHECKPOINTS[0][1] * 60
    const last = Math.min(row.closedAt, startsAt + CHECKPOINTS.at(-1)![1] * 60)
    if (first >= last) {
      skip('market closed before first checkpoint')
      continue
    }
    const candles = await kalshiCandles(ref.eventTicker, row.external_id, first - 16 * 60, last, 1, 600_000)
      .catch(() => [] as KalshiCandle[])
    if (candles.length === 0) {
      skip('no quote history')
      continue
    }

    // The market baseline and sportsbook comparison remain usable without trades.
    const trades = await kalshiTrades(row.external_id, first - 25 * 3600, last).catch(() => null)
    if (!trades)
      skip('no trade tape')
    const tape = trades ? tapeDatabase(Number(row.id), trades) : null
    try {
      for (const [checkpoint, offset] of CHECKPOINTS) {
        const ts = startsAt + offset * 60
        if (ts >= row.closedAt) {
          skip('checkpoint after market close')
          continue
        }
        const point = quoteAt(candles, ts)
        if (!point || point.ts < row.openedAt) {
          skip('no usable bid and ask at checkpoint')
          continue
        }
        checkpoints++
        brierMarket.push((point.mid - outcome) ** 2)

        let candidate: Candidate | null = null
        if (tape) {
          try {
            candidate = await evaluateMarketAt(tape.db, row, { asOf: point.ts * 1000, yesPriceAt: point.mid, game: gameAt(game, ts, startsAt) })
          }
          catch {
            skip('evidence replay failed')
          }
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

        const place = (strategy: string, side: 'yes' | 'no', forecast = candidate ? modelYes : null) => {
          const price = costOf(point, side)
          if (price <= 0.01 || price >= 0.99)
            return
          const won = side === 'yes' ? outcome === 1 : outcome === 0
          const { fee, pnl } = settleBet(stake, price, won)
          bets.push({ strategy, ticker: row.external_id, label: row.outcome_label || row.question, checkpoint, at: ts, side, price, stake, fee, won, pnl, mid: Math.round(point.mid * 1000) / 1000, fair: forecast === null ? null : Math.round(forecast * 1000) / 1000 })
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
          // What the live strategy would actually do: the same edge floor, its
          // confidence floor (Strategy 1: 0.60) and the tradable price band.
          if (candidate.confidence >= minConfidence && tradablePrice(costOf(point, side))) {
            place('rules', side)
            if (checkpoint === 'pre-game')
              place('rules-pre', side)
          }
        }

        if (options.consensusDb && checkpoint === 'pre-game' && game) {
          const consensus: SportsbookForecast | null = await sportsbookConsensus(options.consensusDb, game, point.ts * 1000)
          if (consensus) {
            consensusViews.push({ ticker: row.external_id, at: point.ts, market: point.mid, sportsbook: consensus.probability, books: consensus.books, outcome })
            const forecasts = [
              ['sportsbook', consensus.probability],
              ['sportsbook-blend', (consensus.probability + point.mid) / 2],
            ] as const
            for (const [strategy, probability] of forecasts) {
              const side = probability > point.mid ? 'yes' : 'no'
              const price = costOf(point, side)
              const fair = side === 'yes' ? probability : 1 - probability
              const feePerContract = kalshiFee(stake / price, price) / (stake / price)
              if (Math.abs(probability - point.mid) >= minEdge && tradablePrice(price) && fair > price + feePerContract)
                place(strategy, side, probability)
            }
          }
          else {
            skip('no fresh two-book consensus')
          }
        }

        // Plain baselines, to tell skill from luck.
        place('favorite', point.mid >= 0.5 ? 'yes' : 'no')
        place('underdog', point.mid >= 0.5 ? 'no' : 'yes')

        // Momentum over the previous fifteen minutes, in play only.
        if (checkpoint !== 'pre-game') {
          const before = quoteAt(candles, point.ts - 15 * 60)
          const move = before ? point.mid - before.mid : 0
          if (Math.abs(move) >= 0.08) {
            place('momentum', move > 0 ? 'yes' : 'no')
            place('fade', move > 0 ? 'no' : 'yes')
          }
        }
      }
    }
    finally {
      tape?.close()
    }
  }

  const strategies = summarizeBets(bets, bankroll)

  const mean = (values: number[]) => values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10000) / 10000 : null
  return {
    date: options.date,
    events: events.length,
    checkpoints,
    brier: { market: mean(brierMarket), model: mean(brierModel), modelViews },
    consensus: options.consensusDb ? summarizeConsensus(consensusViews) : undefined,
    consensusViews,
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
