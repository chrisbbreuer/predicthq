import { Database } from '../../Support/db'
import { assessMismatch, loadTeamFundamentals } from '../fundamentals/mismatch'
import { outcomeSideOf, resolveFixture } from '../ingest/kalshi-games'
import { findIncoherence, fixtureKeyOf, strikeOf } from '../quant/coherence'
import { movementFor } from '../quant/movement'
import { assessScheduleEdge, loadScheduleContext } from '../quant/schedule'

/**
 * Evidence — the measurable case for or against a side, computed from
 * our own ingested tape and nothing else.
 *
 * This is deliberately the whole quantitative model. The AI layer that
 * sits above it can only argue about candidates produced here; it cannot
 * introduce a market, a side, or a fair value of its own. That ordering
 * is what makes "AI-driven" checkable: every automated position traces
 * back to rows in market_trades and prediction_markets, and each signal
 * records the sample it stood on.
 *
 * Fair value starts at the venue's own price — the market is the best
 * single estimate available — and each signal nudges it. Nudges are
 * additive in probability points and individually clamped, so no single
 * signal can run away with the estimate, and the total is clamped again.
 */

/** Lookback for the flow and smart-money queries. */
const WINDOW_HOURS = 24
/** Bayesian prior weight, mirroring the analytics pass's shrinkage. */
const PRIOR_WEIGHT = 6
/** No single signal may move fair value more than this. */
const MAX_SIGNAL_CONTRIBUTION = 0.08
/** Nor may all of them together. */
const MAX_TOTAL_CONTRIBUTION = 0.15
/** Below this many fills a market is too thin to model at all. */
const MIN_FILLS = 8

export interface EvidenceItem {
  kind: string
  summary: string
  value: number
  contribution: number
  sampleSize: number
  windowHours: number
}

export interface Candidate {
  predictionMarketId: number
  venue: string
  externalId: string
  question: string
  category: string
  /** Side the evidence favours. */
  side: string
  /** The venue's price for that side, 0..1. */
  marketPrice: number
  /** Our estimate for that side, 0..1. */
  fairValue: number
  /** fairValue − marketPrice. */
  edge: number
  /** 0..1, from how much agreeing evidence there is. */
  confidence: number
  liquidity: number
  evidence: EvidenceItem[]
}

interface MarketRow {
  id: number
  venue: string
  external_id: string
  question: string
  category: string
  last_price: number
  liquidity: number
  outcome_label: string
}

interface FlowRow {
  side: string
  fills: number
  notional: number
  /** Notional weighted by the buyer's smart score, 0..100. */
  smart_notional: number
  /** Resolved wins over resolved trades, for the accounts in this flow. */
  resolved: number
  wins: number
}

type MarketDatabaseRow = Omit<MarketRow, 'id' | 'last_price' | 'liquidity'> & {
  id: number | string
  last_price: number | string
  liquidity: number | string
}

type FlowDatabaseRow = Omit<FlowRow, 'fills' | 'notional' | 'smart_notional' | 'resolved' | 'wins'> & {
  fills: number | string
  notional: number | string
  smart_notional: number | string
  resolved: number | string
  wins: number | string
}

export interface EvidenceOptions {
  /** Restrict to these venues. Empty means both. */
  venues?: string[]
  /** Restrict to these categories. Empty means all. */
  categories?: string[]
  /** Minimum absolute edge to report a candidate at all. */
  minEdge?: number
  limit?: number
}

/**
 * Build the candidate set.
 *
 * Only open markets with a real price and enough recent flow qualify —
 * an untraded market has no evidence, and a fair value derived from
 * nothing is worse than no opinion.
 */
export async function buildCandidates(db: Database, options: EvidenceOptions = {}): Promise<Candidate[]> {
  const venues = options.venues?.filter(Boolean) ?? []
  const categories = options.categories?.filter(Boolean) ?? []
  const minEdge = options.minEdge ?? 0.03
  const limit = options.limit ?? 40

  const where: string[] = [
    `status = 'open'`,
    `last_price > 0.02`,
    `last_price < 0.98`,
  ]
  const params: string[] = []

  if (venues.length > 0) {
    where.push(`venue IN (${venues.map(() => '?').join(', ')})`)
    params.push(...venues)
  }

  if (categories.length > 0) {
    where.push(`LOWER(category) IN (${categories.map(() => '?').join(', ')})`)
    params.push(...categories.map(c => c.toLowerCase()))
  }

  const markets = await db.prepare<MarketDatabaseRow>(`
    SELECT id, venue, external_id, question, outcome_label, category, last_price, liquidity
    FROM prediction_markets
    WHERE ${where.join(' AND ')}
    ORDER BY volume DESC
    LIMIT 400
  `).all(...params)

  const candidates: Candidate[] = []

  for (const rawMarket of markets) {
    const market = normalizeMarketRow(rawMarket)
    const candidate = await evaluateMarket(db, market)
    if (candidate && Math.abs(candidate.edge) >= minEdge)
      candidates.push(candidate)
  }

  // Strongest conviction first: edge alone rewards thin markets where
  // the estimate is least trustworthy, so rank on edge × confidence.
  candidates.sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence))

  return candidates.slice(0, limit)
}

/**
 * Evaluate one market: gather the per-side flow, pick the side the
 * evidence favours, and record what moved the estimate.
 */
async function evaluateMarket(db: Database, market: MarketRow): Promise<Candidate | null> {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()

  const flowRows = await db.prepare<FlowDatabaseRow>(`
    SELECT
      t.side AS side,
      COUNT(*) AS fills,
      COALESCE(SUM(t.notional), 0) AS notional,
      COALESCE(SUM(t.notional * COALESCE(tr.smart_score, 0) / 100.0), 0) AS smart_notional,
      COALESCE(SUM(CASE WHEN t.is_winner != -1 THEN 1 ELSE 0 END), 0) AS resolved,
      COALESCE(SUM(CASE WHEN t.is_winner = 1 THEN 1 ELSE 0 END), 0) AS wins
    FROM market_trades t
    LEFT JOIN market_traders tr ON tr.id = t.market_trader_id
    WHERE t.prediction_market_id = ? AND t.traded_at >= ?
    GROUP BY t.side
  `).all(market.id, since)
  const flows = flowRows.map(normalizeFlowRow)

  const totalFills = flows.reduce((sum, f) => sum + f.fills, 0)
  if (totalFills < MIN_FILLS)
    return null

  // The side with the most notional behind it is the one being argued
  // for; everything else is the other side of the same claim.
  const leader = flows.reduce<FlowRow | null>((best, f) => (!best || f.notional > best.notional ? f : best), null)
  if (!leader)
    return null

  const totalNotional = flows.reduce((sum, f) => sum + f.notional, 0)
  if (totalNotional <= 0)
    return null

  // `last_price` is quoted for the yes side. A candidate on any other
  // side is worth the complement.
  const marketPrice = leader.side === 'yes' ? market.last_price : 1 - market.last_price

  const evidence: EvidenceItem[] = []

  // ---- Flow imbalance -------------------------------------------------
  // What share of the money over the window bought this side. Centered
  // on the price itself rather than 0.5: a side already quoted at 0.8
  // should attract ~80% of the flow, so only the excess is information.
  const flowShare = leader.notional / totalNotional
  evidence.push({
    kind: 'flow_imbalance',
    summary: `${pct(flowShare)} of $${round(totalNotional)} traded in ${WINDOW_HOURS}h bought ${leader.side}`,
    value: round(flowShare, 4),
    contribution: clampSignal((flowShare - marketPrice) * 0.10),
    sampleSize: totalFills,
    windowHours: WINDOW_HOURS,
  })

  // ---- Smart money ----------------------------------------------------
  // The same flow, weighted by each buyer's smart score. Only meaningful
  // where trades are attributable — Kalshi's tape is anonymous, so its
  // smart notional is structurally zero and the signal is skipped rather
  // than reported as a real zero.
  const smartShareTotal = flows.reduce((sum, f) => sum + f.smart_notional, 0)
  if (smartShareTotal > 0) {
    const smartShare = leader.smart_notional / smartShareTotal
    evidence.push({
      kind: 'smart_money',
      summary: `accuracy-weighted flow puts ${pct(smartShare)} behind ${leader.side}`,
      value: round(smartShare, 4),
      contribution: clampSignal((smartShare - marketPrice) * 0.18),
      sampleSize: totalFills,
      windowHours: WINDOW_HOURS,
    })
  }

  // ---- Trader accuracy ------------------------------------------------
  // How the accounts on this side have actually done on settled markets,
  // shrunk toward a coin flip so a 2-for-2 record does not outrank a
  // 40-for-50 one.
  if (leader.resolved > 0) {
    const shrunk = (leader.wins + PRIOR_WEIGHT * 0.5) / (leader.resolved + PRIOR_WEIGHT)
    evidence.push({
      kind: 'trader_accuracy',
      summary: `buyers of ${leader.side} are ${leader.wins}/${leader.resolved} on settled markets (${pct(shrunk)} shrunk)`,
      value: round(shrunk, 4),
      contribution: clampSignal((shrunk - 0.5) * 0.20),
      sampleSize: leader.resolved,
      windowHours: WINDOW_HOURS,
    })
  }

  // ---- Price trend ----------------------------------------------------
  // Where the side has traded recently versus the window as a whole.
  const trend = await db.prepare<{ recent: number, baseline: number, n: number }>(`
    SELECT
      COALESCE(AVG(CASE WHEN traded_at >= ? THEN price END), 0) AS recent,
      COALESCE(AVG(price), 0) AS baseline,
      COUNT(*) AS n
    FROM market_trades
    WHERE prediction_market_id = ? AND side = ? AND traded_at >= ?
  `).get(
    new Date(Date.now() - 3600_000 * 4).toISOString(),
    market.id,
    leader.side,
    since,
  )

  if (trend && trend.recent > 0 && trend.baseline > 0) {
    const drift = trend.recent - trend.baseline
    evidence.push({
      kind: 'price_trend',
      summary: `${leader.side} traded at ${pct(trend.recent)} in the last 4h vs ${pct(trend.baseline)} over ${WINDOW_HOURS}h`,
      value: round(drift, 4),
      contribution: clampSignal(drift * 0.25),
      sampleSize: trend.n,
      windowHours: WINDOW_HOURS,
    })
  }

  // ---- Liquidity ------------------------------------------------------
  // Recorded because it caps size downstream, never as a directional
  // argument — hence a zero contribution.
  evidence.push({
    kind: 'liquidity',
    summary: `$${round(market.liquidity)} resting liquidity`,
    value: round(market.liquidity, 2),
    contribution: 0,
    sampleSize: 1,
    windowHours: WINDOW_HOURS,
  })

  // ---- Cross-venue ----------------------------------------------------
  // The same question priced on the other venue. Two venues that
  // disagree is the cleanest signal available, and the only one here
  // that does not depend on our own trader modelling.
  const other = await db.prepare<{ venue: string, last_price: number }>(`
    SELECT venue, last_price
    FROM prediction_markets
    WHERE venue != ? AND status = 'open' AND question = ? AND last_price > 0
    LIMIT 1
  `).get(market.venue, market.question)

  if (other) {
    const otherPrice = leader.side === 'yes' ? other.last_price : 1 - other.last_price
    const gap = otherPrice - marketPrice
    evidence.push({
      kind: 'cross_venue',
      summary: `${other.venue} prices ${leader.side} at ${pct(otherPrice)} vs ${pct(marketPrice)} here`,
      value: round(gap, 4),
      contribution: clampSignal(gap * 0.35),
      sampleSize: 1,
      windowHours: WINDOW_HOURS,
    })
  }

  // The fixture this market is about, resolved once. Two signals below
  // need it, and both need the same answer.
  const fixture = await resolveFixture(db, { ticker: market.external_id, title: market.question })

  // Which of the three outcomes this market is. Null on a draw market or
  // an unreadable ticker, and both are skipped: a strength read says who
  // is better, which is not an argument for or against a draw.
  const outcome = fixture ? outcomeSideOf(market.external_id, fixture, market.outcome_label) : null

  // ---- Reverse line movement ------------------------------------------
  // The money went one way and the price went the other.
  //
  // Normally price follows flow: buyers lift the offer and the quote
  // rises. When it does not, someone is willing to absorb that flow at a
  // worse price than the crowd is paying, and historically that someone
  // is better informed than the crowd. It is the one signal here that
  // reads a disagreement rather than a majority, which is why a lopsided
  // flow imbalance and a reverse move mean opposite things.
  //
  // `feature_snapshots.reverse_line_move` has been written as a hardcoded
  // zero since it was added, so this is the first real computation of it.
  const half = new Date(Date.now() - (WINDOW_HOURS / 2) * 3600_000).toISOString()

  const halves = await db.prepare<{ earlier: number, later: number, recentFills: number }>(`
    SELECT
      COALESCE(AVG(CASE WHEN traded_at < ? THEN price END), 0) AS earlier,
      COALESCE(AVG(CASE WHEN traded_at >= ? THEN price END), 0) AS later,
      COALESCE(SUM(CASE WHEN traded_at >= ? THEN 1 ELSE 0 END), 0) AS recentFills
    FROM market_trades
    WHERE prediction_market_id = ? AND traded_at >= ?
  `).get(half, half, half, market.id, since)

  // Both halves need real trades, or the "move" is just one half being
  // empty and averaging to zero.
  if (halves && halves.earlier > 0 && halves.later > 0 && halves.recentFills >= MIN_FILLS / 2) {
    // Price move expressed for the leader's side, so the comparison with
    // its flow share is like for like.
    const rawMove = halves.later - halves.earlier
    const move = leader.side === 'yes' ? rawMove : -rawMove
    const flowLead = (leader.notional / totalNotional) - 0.5

    // Reverse means flow favoured this side while its price fell.
    if (flowLead > 0.1 && move < -0.005) {
      evidence.push({
        kind: 'reverse_line_move',
        summary: `${pct(leader.notional / totalNotional)} of flow bought ${leader.side} while its price fell ${pct(Math.abs(move))}`,
        value: round(move, 4),
        // Against the leader: the side taking the other end of a crowded
        // trade at a worse price is the side worth respecting.
        contribution: clampSignal(move * 0.5),
        sampleSize: halves.recentFills,
        windowHours: WINDOW_HOURS,
      })
    }
  }

  // ---- Ladder incoherence ---------------------------------------------
  // The venue disagreeing with itself. A spread or total is listed as a
  // ladder and its rungs are ordered by arithmetic, not by opinion:
  // clearing a higher bar cannot be likelier than clearing a lower one.
  // An inversion is therefore not an estimate that the market is wrong,
  // it is a proof, which is why this is the one signal allowed the full
  // per-signal cap on its own.
  const fixtureKey = fixtureKeyOf(market.external_id)

  if (fixtureKey && strikeOf(market.external_id) !== null) {
    const siblings = await db.prepare<{ ticker: string, price: number }>(`
      SELECT external_id AS ticker, last_price AS price
      FROM prediction_markets
      WHERE venue = ? AND status = 'open' AND external_id LIKE ?
    `).all(market.venue, `%-${fixtureKey}-%`)

    for (const violation of findIncoherence(siblings)) {
      // Only the rung being priced, and only when this market is the one
      // quoted too high. The cheap side of an inversion is not the trade.
      if (violation.ticker !== market.external_id)
        continue

      // Against the yes side of this rung: it is the one priced above a
      // strictly easier outcome.
      const towardsLeader = leader.side === 'yes' ? -violation.gap : violation.gap

      evidence.push({
        kind: 'ladder_incoherence',
        summary: `priced ${pct(violation.price)} against ${pct(violation.versusPrice)} for the easier ${violation.versusStrike}`,
        value: round(violation.gap, 4),
        contribution: clampSignal(towardsLeader),
        sampleSize: 2,
        windowHours: 0,
      })
      break
    }
  }

  // ---- Rest and congestion --------------------------------------------
  // Derived from fixtures already on file, so it costs nothing and it is
  // the effect books price slowest: the second night of a back-to-back
  // for the road side is well documented and routinely under-adjusted.
  if (fixture?.matched && fixture.commenceAt) {
    const homeSchedule = await loadScheduleContext(db, fixture.homeTeamId!, fixture.commenceAt)
    const awaySchedule = await loadScheduleContext(db, fixture.awayTeamId!, fixture.commenceAt)
    const schedule = assessScheduleEdge(homeSchedule, awaySchedule)

    if (schedule.confidence > 0 && Math.abs(schedule.edge) > 0.01 && (outcome === 'home' || outcome === 'away')) {
      const towardsOutcome = outcome === 'home' ? schedule.edge : -schedule.edge
      const favoursLeader = leader.side === 'yes' ? towardsOutcome : -towardsOutcome

      evidence.push({
        kind: 'schedule_rest',
        summary: schedule.reasons.join('; '),
        value: round(schedule.edge, 4),
        // Smaller than the mismatch cap: rest is a real effect and a
        // modest one, and it has no settled history here yet either.
        contribution: clampSignal(favoursLeader * schedule.confidence * 0.04),
        sampleSize: schedule.reasons.length,
        windowHours: 0,
      })
    }
  }

  // ---- Sportsbook steam -----------------------------------------------
  // Many books repricing the same selection together, read off the
  // sportsbook feed rather than the prediction venue. One book moving is
  // that book adjusting; a consensus moving is the market learning
  // something, and it happens on the sportsbook side first because that
  // is where the volume and the risk managers are.
  //
  // Reachable only now that a Kalshi market resolves to one of our own
  // fixtures. `movementFor` has computed this since it was written and
  // nothing consumed it, because the two halves of the system had no
  // link between them.
  if (fixture?.marketEventId && (outcome === 'home' || outcome === 'away')) {
    const selection = await db.prepare<{ id: number }>(`
      SELECT s.id AS id
      FROM selections s
      JOIN markets mk ON mk.id = s.market_id
      WHERE mk.market_event_id = ? AND mk.market_type = 'h2h' AND s.side = ?
      LIMIT 1
    `).get(fixture.marketEventId, outcome)

    if (selection) {
      const move = await movementFor(db, selection.id)

      if (move.steamScore > 0 && Math.abs(move.moveFromOpenPct) > 0.1) {
        // Decimal odds falling means the selection shortened, which is
        // the books making it MORE likely. So the sign flips: a negative
        // move is support for this outcome.
        const towardsOutcome = move.moveFromOpenPct < 0 ? 1 : -1
        const towardsLeader = leader.side === 'yes' ? towardsOutcome : -towardsOutcome

        evidence.push({
          kind: 'steam',
          summary: `books moved together ${move.moveFromOpenPct > 0 ? 'against' : 'toward'} ${fixture[outcome === 'home' ? 'home' : 'away']} (${pct(move.steamScore)} consensus)`,
          value: round(move.steamScore, 4),
          contribution: clampSignal(towardsLeader * move.steamScore * 0.05),
          sampleSize: 1,
          windowHours: 0,
        })
      }
    }
  }

  // ---- Squad mismatch -------------------------------------------------
  // The only signal here that does not come from a price. Everything
  // above reads the tape: flow, trader records, trend, the other venue's
  // quote. All of them can tell you what the market believes and none can
  // tell you it is wrong, because the market is their input.
  //
  // Tier and squad value are an outside opinion, which is what a cup tie
  // between a second-division side and a fourth-division one needs: the
  // fixture arrives as two names and a price, and nothing else in this
  // file can see that it is lopsided.


  if (fixture?.matched && (outcome === 'home' || outcome === 'away')) {
    const home = await loadTeamFundamentals(db, fixture.homeTeamId!)
    const away = await loadTeamFundamentals(db, fixture.awayTeamId!)
    const mismatch = assessMismatch(home, away)

    if (mismatch.confidence > 0 && Math.abs(mismatch.edge) > 0.01) {
      // `edge` favours home. Flip it for an away market, then flip again
      // when the flow leads 'no', because backing 'no' on the stronger
      // side is a bet against them.
      const towardsOutcome = outcome === 'home' ? mismatch.edge : -mismatch.edge
      const favoursLeader = leader.side === 'yes' ? towardsOutcome : -towardsOutcome

      // Scaled by confidence and held well under the per-signal cap. The
      // strength read is an ordering, not a calibrated probability, and
      // until settled results say what a tier gap is worth it has no
      // business moving fair value as hard as a measured flow imbalance.
      const contribution = favoursLeader * mismatch.confidence * 0.06

      evidence.push({
        kind: 'squad_mismatch',
        summary: mismatch.reasons.join('; ') || 'Fundamentals favour one side',
        value: round(mismatch.edge, 4),
        contribution: clampSignal(contribution),
        sampleSize: mismatch.reasons.length,
        windowHours: 0,
      })
    }
  }

  const totalContribution = clamp(
    evidence.reduce((sum, item) => sum + item.contribution, 0),
    -MAX_TOTAL_CONTRIBUTION,
    MAX_TOTAL_CONTRIBUTION,
  )

  const fairValue = clamp(marketPrice + totalContribution, 0.01, 0.99)

  return {
    predictionMarketId: market.id,
    venue: market.venue,
    externalId: market.external_id,
    question: market.question,
    category: market.category,
    side: leader.side,
    marketPrice: round(marketPrice, 4),
    fairValue: round(fairValue, 4),
    edge: round(fairValue - marketPrice, 4),
    confidence: confidenceFrom(evidence, totalFills),
    liquidity: Number(market.liquidity),
    evidence,
  }
}

function normalizeMarketRow(row: MarketDatabaseRow): MarketRow {
  return {
    ...row,
    id: Number(row.id),
    last_price: Number(row.last_price),
    liquidity: Number(row.liquidity),
  }
}

function normalizeFlowRow(row: FlowDatabaseRow): FlowRow {
  return {
    ...row,
    fills: Number(row.fills),
    notional: Number(row.notional),
    smart_notional: Number(row.smart_notional),
    resolved: Number(row.resolved),
    wins: Number(row.wins),
  }
}

/**
 * Confidence from agreement and sample size, not from edge.
 *
 * Three signals pointing the same way on 300 fills is a different claim
 * from one signal on 9, even when both produce the same number. Agreement
 * is the share of directional signals that share the majority sign;
 * depth saturates so a very heavily traded market does not get arbitrarily
 * confident.
 */
function confidenceFrom(evidence: EvidenceItem[], fills: number): number {
  const directional = evidence.filter(item => item.contribution !== 0)
  if (directional.length === 0)
    return 0

  const positive = directional.filter(item => item.contribution > 0).length
  const agreement = Math.max(positive, directional.length - positive) / directional.length

  // Saturating depth: 8 fills ≈ 0.1, 100 ≈ 0.6, 500 ≈ 0.85.
  const depth = fills / (fills + 90)

  // Two signals is the floor for taking anything seriously.
  const breadth = Math.min(1, directional.length / 3)

  return round(clamp(agreement * 0.5 + depth * 0.3 + breadth * 0.2, 0, 1), 3)
}

function clampSignal(value: number): number {
  return round(clamp(value, -MAX_SIGNAL_CONTRIBUTION, MAX_SIGNAL_CONTRIBUTION), 4)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
