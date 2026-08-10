import type { Candidate } from './evidence'
import type { Strategy } from './execute'
import { Database } from '../../Support/db'
import { log } from '@stacksjs/logging'
import { resolveEntitlements } from '../billing/entitlements'
import { judgeCandidates } from './decide'
import { buildCandidates } from './evidence'
import { executeStrategy, stakeFor } from './execute'

/**
 * One pass of the trading loop for one strategy.
 *
 * The order is fixed and each step narrows the last:
 *
 *   1. our data proposes candidates      (evidence.ts)
 *   2. the model accepts or declines     (decide.ts)
 *   3. the strategy's limits size them   (here)
 *   4. the risk checks and the venue     (execute.ts)
 *
 * Decisions are persisted at step 3 whether or not they will execute, so
 * a Signal-tier user sees exactly what an Auto-tier one would have
 * traded. That is the product: the difference between the plans is who
 * places the order, not who gets to see the reasoning.
 */

export interface RunSummary {
  strategyId: number
  candidates: number
  accepted: number
  decisionsWritten: number
  ordersPlaced: number
  skipped: number
  decidedBy: string
}

/** Every strategy the loop should consider this pass. */
export async function activeStrategies(db: Database): Promise<Strategy[]> {
  return await db.prepare<Strategy>(`
    SELECT id, user_id, venue, mode, bankroll, max_stake, min_edge, min_confidence,
          max_open_positions, daily_loss_limit, cumulative_loss_limit, auto_execute, status
    FROM trading_strategies
    WHERE status = 'active'
    ORDER BY id
  `).all()
}

export async function runStrategy(db: Database, strategy: Strategy): Promise<RunSummary> {
  const now = new Date().toISOString()

  const summary: RunSummary = {
    strategyId: strategy.id,
    candidates: 0,
    accepted: 0,
    decisionsWritten: 0,
    ordersPlaced: 0,
    skipped: 0,
    decidedBy: 'rules',
  }

  const categories = await readCategories(db, strategy.id)

  const candidates = await buildCandidates(db, {
    venues: strategy.venue === 'both' ? [] : [strategy.venue],
    categories,
    minEdge: strategy.min_edge,
  })

  summary.candidates = candidates.length

  if (candidates.length === 0) {
    await touch(db, strategy.id, now)
    return summary
  }

  // Model judgement is a paid tier feature. Without it the deterministic
  // scores decide alone — which is a complete procedure, not a degraded
  // one, so the loop still runs end to end on every plan.
  const entitlements = await resolveEntitlements(db, strategy.user_id)
  const judgements = entitlements.canUseDeepResearch
    ? await judgeCandidates(candidates)
    : candidates.map(c => ({
        predictionMarketId: c.predictionMarketId,
        accept: c.edge > 0,
        confidence: c.confidence,
        rationale: `Fair value ${(c.fairValue * 100).toFixed(1)}% vs ${(c.marketPrice * 100).toFixed(1)}% quoted.`,
        decidedBy: 'rules',
      }))

  summary.decidedBy = judgements[0]?.decidedBy ?? 'rules'

  const byMarket = new Map(candidates.map(c => [c.predictionMarketId, c]))
  const approved: number[] = []

  for (const judgement of judgements) {
    const candidate = byMarket.get(judgement.predictionMarketId)
    if (!candidate)
      continue

    const accepted = judgement.accept && judgement.confidence >= strategy.min_confidence
    if (judgement.accept)
      summary.accepted++

    const stake = accepted ? stakeFor(candidate, strategy, strategy.bankroll) : 0
    // Cross the spread by a point so a limit derived from fair value can
    // actually fill; anything above fair value gives away the edge, so
    // it is capped there.
    const limitPrice = Math.min(candidate.fairValue, candidate.marketPrice + 0.01)
    const size = limitPrice > 0 ? Math.floor(stake / limitPrice) : 0

    const status = !judgement.accept
      ? 'rejected'
      : judgement.confidence < strategy.min_confidence
          ? 'skipped'
          : size < 1
            ? 'skipped'
            : 'approved'

    const statusReason = status === 'rejected'
      ? 'declined on review'
      : judgement.confidence < strategy.min_confidence
        ? `confidence ${judgement.confidence.toFixed(2)} below the ${strategy.min_confidence.toFixed(2)} floor`
        : size < 1
          ? 'sized below one contract'
          : ''

    const decisionId = await upsertDecision(db, strategy.id, candidate, {
      side: candidate.side,
      limitPrice,
      size,
      notional: Math.round(size * limitPrice * 100) / 100,
      confidence: judgement.confidence,
      rationale: judgement.rationale,
      decidedBy: judgement.decidedBy,
      status,
      statusReason,
    }, now)

    summary.decisionsWritten++

    if (status === 'approved')
      approved.push(decisionId)
    else
      summary.skipped++
  }

  if (approved.length > 0) {
    const outcomes = await executeStrategy(db, strategy, approved)
    summary.ordersPlaced = outcomes.filter(o => o.placed).length
    summary.skipped += outcomes.filter(o => !o.placed).length
  }

  await touch(db, strategy.id, now)
  return summary
}

/** Run every active strategy. */
export async function runAllStrategies(db: Database): Promise<RunSummary[]> {
  const summaries: RunSummary[] = []

  for (const strategy of await activeStrategies(db)) {
    try {
      summaries.push(await runStrategy(db, strategy))
    }
    catch (error) {
      // One strategy's failure is not the loop's. A malformed strategy
      // or a dead venue account must not stop every other user's pass.
      log.error(`[trading] strategy ${strategy.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return summaries
}

interface DecisionWrite {
  side: string
  limitPrice: number
  size: number
  notional: number
  confidence: number
  rationale: string
  decidedBy: string
  status: string
  statusReason: string
}

/**
 * Write the decision and replace its evidence.
 *
 * A strategy holds one standing opinion per market, and re-running it
 * updates that opinion rather than stacking a second decision that
 * becomes a second order. But an opinion is only standing until it is
 * finished: once a decision has been acted on and its order is no longer
 * working, the market is open to be considered again, and the next pass
 * starts a fresh decision beside the old one instead of overwriting a
 * record an order still points at.
 *
 * The one case that must not re-decide is a decision whose order is
 * still live. Re-deciding there would place a second order into a
 * position the first one is still building.
 */
async function upsertDecision(
  db: Database,
  strategyId: number,
  candidate: Candidate,
  write: DecisionWrite,
  now: string,
): Promise<number> {
  return await db.transaction(async (transaction) => {
  const existing = await transaction.prepare<{ id: number, status: string, working: number }>(`
    SELECT
      d.id,
      d.status,
      (
        SELECT COUNT(*) FROM exchange_orders o
        WHERE o.trade_decision_id = d.id AND o.status IN ('pending', 'open', 'partial')
      ) AS working
    FROM trade_decisions d
    WHERE d.trading_strategy_id = ? AND d.prediction_market_id = ?
    ORDER BY d.id DESC
    LIMIT 1
  `).get(strategyId, candidate.predictionMarketId)

  // An order still on the book owns this market until it is done.
  if (existing && Number(existing.working) > 0)
    return existing.id

  // Anything already acted on is history. The next opinion is its own
  // row, so the decision feed reads as a sequence of judgements rather
  // than one row that keeps changing its mind under an executed order.
  const settled = existing !== null
    && ['executed', 'failed', 'expired'].includes(existing.status)

  let decisionId: number

  if (existing && !settled) {
    await transaction.prepare(`
      UPDATE trade_decisions SET
        venue = ?, side = ?, market_price = ?, fair_value = ?, edge = ?, confidence = ?,
        limit_price = ?, size = ?, notional = ?, rationale = ?, decided_by = ?,
        status = ?, status_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      candidate.venue, write.side, candidate.marketPrice, candidate.fairValue, candidate.edge,
      write.confidence, write.limitPrice, write.size, write.notional, write.rationale,
      write.decidedBy, write.status, write.statusReason, now, existing.id,
    )
    decisionId = existing.id
  }
  else {
    const insert = await transaction.prepare(`
      INSERT INTO trade_decisions (
        trading_strategy_id, prediction_market_id, venue, side, market_price, fair_value,
        edge, confidence, limit_price, size, notional, rationale, decided_by,
        status, status_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId, candidate.predictionMarketId, candidate.venue, write.side,
      candidate.marketPrice, candidate.fairValue, candidate.edge, write.confidence,
      write.limitPrice, write.size, write.notional, write.rationale, write.decidedBy,
      write.status, write.statusReason, now, now,
    )
    decisionId = Number(insert.lastInsertRowid)
  }

  // Evidence describes one moment. Replacing it wholesale keeps the rows
  // consistent with the decision they sit next to, instead of mixing
  // this pass's numbers with the last one's.
  await transaction.prepare('DELETE FROM decision_evidence WHERE trade_decision_id = ?').run(decisionId)

  const insertEvidence = transaction.prepare(`
    INSERT INTO decision_evidence (
      trade_decision_id, kind, summary, value, contribution, sample_size, window_hours,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const item of candidate.evidence) {
    await insertEvidence.run(
      decisionId, item.kind, item.summary, item.value, item.contribution,
      item.sampleSize, item.windowHours, now, now,
    )
  }

  return decisionId
  })
}

/** The strategy's category allowlist, as lowercase names. */
async function readCategories(db: Database, strategyId: number): Promise<string[]> {
  const row = await db.prepare<{ categories: string | null }>('SELECT categories FROM trading_strategies WHERE id = ?')
    .get(strategyId)

  return (row?.categories ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

async function touch(db: Database, strategyId: number, now: string): Promise<void> {
  await db.prepare('UPDATE trading_strategies SET last_run_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, strategyId)
}
