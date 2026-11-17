import { Database } from './db'
import { buildCandidates } from '../Services/trading/evidence'
import { liveGameForTicker } from '../Services/trading/live-games'
import type { Candidate } from '../Services/trading/evidence'
import { snapshot, stale } from './stale'

/**
 * Landing-page reads for the intel surface.
 *
 * Pure query helpers in the shape the STX server scope wants (no ORM in
 * scope there), matching `app/Support/odds.ts`. The landing renders a
 * real candidate with its real evidence rather than a mocked-up one:
 * the whole claim of the product is that decisions are traceable to
 * data, and a fabricated example on the page that makes that claim is
 * the one thing that would undermine it.
 */

export interface IntelSummary {
  marketCount: number
  tradeCount: number
  traderCount: number
  whaleCount: number
  venueCount: number
  /** Fills ingested in the last 24 hours. */
  recentFills: number
}

export interface EvidenceLine {
  kind: string
  label: string
  summary: string
  /** Contribution in probability points, pre-formatted with its sign. */
  points: string
  sampleSize: number
  positive: boolean
}

export interface IntelCandidate {
  venue: string
  question: string
  side: string
  marketPricePct: string
  fairValuePct: string
  edgePts: string
  confidencePct: string
  evidence: EvidenceLine[]
}

/** Human labels for the evidence kinds the engine emits. */
const EVIDENCE_LABELS: Record<string, string> = {
  smart_money: 'Smart money',
  trader_accuracy: 'Trader accuracy',
  flow_imbalance: 'Flow imbalance',
  price_trend: 'Price trend',
  liquidity: 'Liquidity',
  cross_venue: 'Cross venue',
}

function open(): Database {
  return new Database()
}

export async function loadIntelSummary(): Promise<IntelSummary> {
  const db = open()

  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()

    const markets = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM prediction_markets').get()
    const trades = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM market_trades').get()
    const traders = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM market_traders').get()
    const whales = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM market_traders WHERE is_whale = 1').get()
    const venues = await db.query<{ c: number }>('SELECT COUNT(DISTINCT venue) AS c FROM prediction_markets').get()
    const recent = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM market_trades WHERE traded_at >= ?').get(since)

    return {
      marketCount: Number(markets?.c ?? 0),
      tradeCount: Number(trades?.c ?? 0),
      traderCount: Number(traders?.c ?? 0),
      whaleCount: Number(whales?.c ?? 0),
      venueCount: Number(venues?.c ?? 0),
      recentFills: Number(recent?.c ?? 0),
    }
  }
  finally {
    db.close()
  }
}

/**
 * The strongest current candidate, formatted for display.
 *
 * Returns null when the tape is too stale to produce one — which the
 * page renders as an honest empty state rather than falling back to an
 * invented example.
 */
const topCandidate = snapshot<Candidate | false>()

/**
 * The engine pass behind the top candidate, served from the last result
 * and refreshed in the background. Run inline it held every board render
 * for most of half a minute against production data.
 */
async function strongestCandidate(): Promise<Candidate | null> {
  const value = await stale(topCandidate, 60_000, async () => {
    const db = open()
    try {
      const [candidate] = await buildCandidates(db, { minEdge: 0.02, limit: 1, gameFor: liveGameForTicker })
      return candidate ?? false
    }
    finally {
      db.close()
    }
  }, false)
  return value || null
}

export async function loadTopCandidate(): Promise<IntelCandidate | null> {
  const candidate = await strongestCandidate()
  if (!candidate)
    return null

  return {
    venue: candidate.venue,
    question: candidate.question,
    side: candidate.side,
    marketPricePct: `${(candidate.marketPrice * 100).toFixed(1)}%`,
    fairValuePct: `${(candidate.fairValue * 100).toFixed(1)}%`,
    edgePts: `${candidate.edge > 0 ? '+' : ''}${(candidate.edge * 100).toFixed(1)}`,
    confidencePct: `${Math.round(candidate.confidence * 100)}%`,
    evidence: candidate.evidence.map(item => ({
      kind: item.kind,
      label: EVIDENCE_LABELS[item.kind] ?? item.kind,
      summary: item.summary,
      points: item.contribution === 0
        ? 'context'
        : `${item.contribution > 0 ? '+' : ''}${(item.contribution * 100).toFixed(2)} pts`,
      sampleSize: item.sampleSize,
      positive: item.contribution > 0,
    })),
  }
}
