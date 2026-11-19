import type { WinnerContext } from './winner-context'

export interface AuditGame {
  ticker: string
  league: string
  day: string
  at: number
  settledAt: number
  bid: number
  ask: number
  outcome: 0 | 1
  context: WinnerContext | null
  consensus: number | null
}

type UnsettledGame = Omit<AuditGame, 'outcome' | 'settledAt'>

const logit = (p: number) => Math.log(p / (1 - p))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const mid = (row: Pick<AuditGame, 'bid' | 'ask'>) => (row.bid + row.ask) / 2
const minTraining = 100

function fit(rows: AuditGame[], base: (row: AuditGame) => number): number[] {
  const weights = [0, 0, 0, 0]
  for (let step = 0; step < 140; step++) {
    const gradient = weights.map(w => w * 0.025)
    for (const row of rows) {
      const features = row.context!
      const error = sigmoid(logit(base(row)) + features.reduce((sum, x, i) => sum + x * weights[i]!, 0)) - row.outcome
      for (let i = 0; i < weights.length; i++)
        gradient[i]! += error * features[i]! / rows.length
    }
    for (let i = 0; i < weights.length; i++)
      weights[i]! -= 0.5 * gradient[i]!
  }
  return weights
}

const addContext = (row: Pick<AuditGame, 'context'>, p: number, weights: number[]) =>
  sigmoid(logit(p) + (row.context?.reduce((sum, x, i) => sum + x * weights[i]!, 0) ?? 0))

export interface FrozenWinnerContext {
  trainBefore: string
  trainingGames: number
  weights: number[]
}

export function fitHistoricalWinnerContext(rows: AuditGame[], trainBefore: string): FrozenWinnerContext {
  const cutoff = Date.parse(trainBefore)
  const training = rows.filter(row => row.context && row.at < cutoff && row.settledAt < cutoff)
  if (training.length < minTraining)
    throw new Error(`Need ${minTraining} resolved historical games before ${trainBefore}`)
  return { trainBefore, trainingGames: training.length, weights: fit(training, mid) }
}

interface ScoredGame { row: AuditGame, forecasts: Record<string, number> }

function summarize(rows: ScoredGame[], variants: string[]) {
  return Object.fromEntries(variants.map(name => {
    let brier = 0
    let logLoss = 0
    const slates = new Map<string, Array<{ confidence: number, won: boolean, ticker: string }>>()
    for (const { row, forecasts } of rows) {
      const p = forecasts[name]!
      brier += (p - row.outcome) ** 2
      logLoss -= Math.log(Math.max(1e-9, row.outcome === 1 ? p : 1 - p))
      const picks = slates.get(row.day) ?? []
      picks.push({ ticker: row.ticker, confidence: Math.max(p, 1 - p), won: (p >= 0.5) === (row.outcome === 1) })
      slates.set(row.day, picks)
    }
    const top = [...slates.values()].flatMap(picks => picks.sort((a, b) => b.confidence - a.confidence || a.ticker.localeCompare(b.ticker)).slice(0, 3))
    const wins = top.filter(p => p.won).length
    return [name, {
      games: rows.length,
      brier: rows.length ? brier / rows.length : null,
      logLoss: rows.length ? logLoss / rows.length : null,
      topThree: { picks: top.length, wins, hitRate: top.length ? wins / top.length : null },
    }]
  }))
}

/** Score the first complete paired settlements using weights frozen before capture began. */
export function prospectiveWinnerAudit(rows: AuditGame[], model: FrozenWinnerContext, games: number) {
  const cutoff = Date.parse(model.trainBefore)
  const eligible = rows.filter(row => row.at >= cutoff && row.consensus !== null && row.context)
  if (eligible.length < games)
    return { eligible: eligible.length, required: games, scores: null }

  const sample = eligible.sort((a, b) => a.settledAt - b.settledAt || a.ticker.localeCompare(b.ticker)).slice(0, games)
  const scored = sample.map(row => {
    const market = mid(row)
    const books = row.consensus!
    const blend = (market + books) / 2
    return { row, forecasts: { market, books, blend, context: addContext(row, blend, model.weights) } }
  })
  return {
    eligible: eligible.length,
    required: games,
    scores: summarize(scored, ['market', 'books', 'blend', 'context']),
  }
}

/** Compare the Kalshi ranking with research probabilities for currently captured games. */
export function rankCapturedWinners(games: UnsettledGame[], training: AuditGame[], asOf: number) {
  const available = training.filter(row => row.context && row.settledAt < asOf)
  const weights = available.length >= minTraining ? fit(available, mid) : null
  return games.map(row => {
    const market = mid(row)
    const marketSide = market >= 0.5 ? 'yes' as const : 'no' as const
    const model = weights && row.context ? addContext(row, market, weights) : null
    return {
      ticker: row.ticker,
      league: row.league,
      marketSide,
      ask: marketSide === 'yes' ? row.ask : 1 - row.bid,
      probability: Math.max(market, 1 - market),
      researchYesProbability: model,
      sportsbookYesProbability: row.consensus,
    }
  }).sort((a, b) => b.probability - a.probability || a.ticker.localeCompare(b.ticker)).slice(0, 10)
}

/** Each slate is scored with weights fit before its first quote. A result has
 * to be settled by then to enter training. The top three are retrospective
 * slate rankings, not a claim those staggered quotes were all tradable at once.
 */
export function predictionAudit(rows: AuditGame[]) {
  const days = [...new Set(rows.map(row => row.day))].sort()
  const context: ScoredGame[] = []
  const paired: ScoredGame[] = []
  const pairedContext: ScoredGame[] = []
  const blend = (row: AuditGame) => (mid(row) + row.consensus!) / 2
  for (const day of days) {
    const tests = rows.filter(row => row.day === day)
    const cutoff = Math.min(...tests.map(row => row.at))
    const earlier = rows.filter(row => row.day < day && row.settledAt < cutoff && row.context)
    const both = earlier.filter(row => row.consensus !== null)
    const weights = earlier.length >= minTraining ? fit(earlier, mid) : null
    const pairWeights = both.length >= minTraining ? fit(both, blend) : null
    for (const row of tests) {
      const p = mid(row)
      if (weights && row.context)
        context.push({ row, forecasts: { market: p, context: addContext(row, p, weights) } })
      if (row.consensus === null)
        continue
      const forecasts = { market: p, books: row.consensus, blend: blend(row) }
      paired.push({ row, forecasts })
      if (pairWeights && row.context)
        pairedContext.push({ row, forecasts: { ...forecasts, context: addContext(row, blend(row), pairWeights) } })
    }
  }
  return {
    settled: rows.length,
    withContext: rows.filter(row => row.context).length,
    paired: summarize(paired, ['market', 'books', 'blend']),
    marketContext: summarize(context, ['market', 'context']),
    pairedContext: summarize(pairedContext, ['market', 'books', 'blend', 'context']),
  }
}
