import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

interface DecisionRow {
  id: number
  trading_strategy_id: number
  strategy_name: string
  venue: string
  question: string
  category: string
  side: string
  market_price: number
  fair_value: number
  edge: number
  confidence: number
  limit_price: number
  size: number
  notional: number
  rationale: string
  decided_by: string
  status: string
  status_reason: string
  created_at: string
}

interface EvidenceRow {
  trade_decision_id: number
  kind: string
  summary: string
  value: number
  contribution: number
  sample_size: number
  window_hours: number
}

/**
 * GET /api/trading/decisions — the decision feed with its evidence.
 *
 * Evidence ships with every decision rather than behind a second
 * request. A decision without its reasons is the thing this product
 * exists not to be, and making the reasons an extra round trip is how
 * they end up unrendered.
 */
export default {
  name: 'GetDecisions',
  description: 'Recent trade decisions, each with the evidence that produced it.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to view decisions.', 401)

    const status = request?.get?.('status') ?? ''
    const limit = Math.min(200, Number(request?.get?.('limit') ?? 50) || 50)

    const db = new Database()

    try {
      const where = status ? 'WHERE s.user_id = ? AND d.status = ?' : 'WHERE s.user_id = ?'
      const params: unknown[] = status ? [userId, status, limit] : [userId, limit]

      const decisions = await db.prepare<DecisionRow>(`
        SELECT
          d.id, d.trading_strategy_id, s.name AS strategy_name, d.venue,
          m.question, m.category, d.side, d.market_price, d.fair_value, d.edge,
          d.confidence, d.limit_price, d.size, d.notional, d.rationale,
          d.decided_by, d.status, d.status_reason, d.created_at
        FROM trade_decisions d
        JOIN trading_strategies s ON s.id = d.trading_strategy_id
        JOIN prediction_markets m ON m.id = d.prediction_market_id
        ${where}
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT ?
      `).all(...params)

      if (decisions.length === 0)
        return { count: 0, decisions: [] }

      const placeholders = decisions.map(() => '?').join(', ')
      const evidence = await db.prepare<EvidenceRow>(`
        SELECT trade_decision_id, kind, summary, value, contribution, sample_size, window_hours
        FROM decision_evidence
        WHERE trade_decision_id IN (${placeholders})
        ORDER BY ABS(contribution) DESC
      `).all(...decisions.map(d => d.id))

      const byDecision = new Map<number, EvidenceRow[]>()
      for (const row of evidence) {
        const list = byDecision.get(row.trade_decision_id) ?? []
        list.push(row)
        byDecision.set(row.trade_decision_id, list)
      }

      return {
        count: decisions.length,
        decisions: decisions.map(d => ({
          id: d.id,
          strategy: { id: d.trading_strategy_id, name: d.strategy_name },
          venue: d.venue,
          question: d.question,
          category: d.category,
          side: d.side,
          marketPrice: d.market_price,
          fairValue: d.fair_value,
          edge: d.edge,
          confidence: d.confidence,
          limitPrice: d.limit_price,
          size: d.size,
          notional: d.notional,
          rationale: d.rationale,
          decidedBy: d.decided_by,
          status: d.status,
          statusReason: d.status_reason,
          createdAt: d.created_at,
          evidence: (byDecision.get(d.id) ?? []).map(e => ({
            kind: e.kind,
            summary: e.summary,
            value: e.value,
            contribution: e.contribution,
            sampleSize: e.sample_size,
            windowHours: e.window_hours,
          })),
        })),
      }
    }
    finally {
      db.close()
    }
  },
}
