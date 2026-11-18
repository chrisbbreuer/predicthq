import type { Database } from '../../Support/db'
import process from 'node:process'
import { nowIso } from '../../Support/keys'

/**
 * The Anthropic reasoning layer.
 *
 * Sits strictly **above** the quantitative one. The model is shown
 * candidates the evidence layer already produced, with their computed fair
 * values, and asked to judge them. It cannot introduce a market, a side,
 * or a fair value of its own, and nothing it returns is used as a
 * probability unless the quant layer also produced one.
 *
 * That ordering is the whole design. It mirrors the constraint already
 * enforced in `app/Services/trading/evidence.ts`, and it is what makes
 * "AI-driven" a checkable claim rather than a decorative one: every
 * automated position still traces back to rows in the database, and the
 * model's contribution is an opinion recorded next to the numbers that
 * prompted it.
 *
 * ### On trusting the output
 * `statedProb` is stored separately from the prose because it is the only
 * part that can be scored, and it *is* scored — `AiInsight.brierScore` is
 * filled in after settlement exactly as the quantitative estimates are.
 * An LLM's stated confidence is worth what its measured calibration says
 * it is worth, and until that has been measured it is worth nothing. The
 * schema is built so the measurement is unavoidable rather than optional.
 *
 * ### Cost
 * Answers are keyed by a hash of the exact feature vector shown to the
 * model. Unchanged inputs reuse the stored answer instead of re-billing
 * for a question already asked, which matters when the scheduler runs
 * every few minutes over hundreds of candidates.
 */

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/** Default model. Fast and cheap enough to run over a whole board. */
const DEFAULT_MODEL = 'claude-sonnet-5'

/** Hard cap per pass, so a scheduler misconfiguration cannot run up a bill. */
const MAX_CANDIDATES_PER_RUN = 25

export interface Candidate {
  selectionId: number
  marketEventId: number
  eventTitle: string
  league: string
  marketType: string
  line: number | null
  side: string
  label: string
  bestPrice: number
  fairProb: number
  sharpProb: number
  edgePct: number
  overroundPct: number
  bookCount: number
  sharpBookCount: number
  methodSpread: number
  moveFromOpenPct: number
  steamScore: number
  hoursToStart: number
}

export interface InsightResult {
  requested: number
  generated: number
  cached: number
  skipped: number
  costUsd: number
  errors: string[]
}

/** Whether the layer is configured at all. */
export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/**
 * The candidates worth spending a model call on.
 *
 * Deliberately narrow. Reviewing every selection would be expensive and
 * mostly pointless: a market where the best price sits within noise of
 * fair value has nothing to explain. The filter asks for a real edge and
 * enough books to believe the fair value in the first place.
 */
export async function loadCandidates(db: Database, limit = MAX_CANDIDATES_PER_RUN): Promise<Candidate[]> {
  return (await db.query<any>(`
    SELECT
      f.selection_id, f.best_price, f.prob_consensus, f.prob_sharp, f.edge_pct,
      f.overround_pct, f.book_count, f.sharp_book_count, f.method_spread,
      s.side, s.label,
      m.market_type, m.line, m.market_event_id,
      e.title AS event_title, e.league, e.commence_at
    FROM fair_prices f
    JOIN selections s ON s.id = f.selection_id
    JOIN markets m ON m.id = s.market_id
    JOIN market_events e ON e.id = m.market_event_id
    WHERE e.status = 'scheduled'
      AND e.commence_at > ?
      AND f.edge_pct > 1.0
      AND f.book_count >= 3
    ORDER BY f.edge_pct DESC
    LIMIT ?
  `).all(nowIso(), limit)).map((r: any) => ({
    // Vitess returns DECIMAL and BIGINT columns as strings.
    selectionId: Number(r.selection_id),
    marketEventId: Number(r.market_event_id),
    eventTitle: r.event_title,
    league: r.league,
    marketType: r.market_type,
    line: r.line === null || r.line === undefined ? null : Number(r.line),
    side: r.side,
    label: r.label,
    bestPrice: Number(r.best_price),
    fairProb: Number(r.prob_consensus),
    sharpProb: Number(r.prob_sharp),
    edgePct: Number(r.edge_pct),
    overroundPct: Number(r.overround_pct),
    bookCount: Number(r.book_count),
    sharpBookCount: Number(r.sharp_book_count),
    methodSpread: Number(r.method_spread),
    moveFromOpenPct: 0,
    steamScore: 0,
    hoursToStart: Math.max(0, (Date.parse(r.commence_at) - Date.now()) / 3_600_000),
  })) as Candidate[]
}

/**
 * A stable fingerprint of what the model was shown.
 *
 * Rounded before hashing: prices wobble in the fourth decimal constantly,
 * and a hash sensitive to that would never hit cache and would bill for
 * every pass while returning the same answer.
 */
export function featureHash(candidate: Candidate): string {
  const canonical = [
    candidate.selectionId,
    candidate.bestPrice.toFixed(2),
    candidate.fairProb.toFixed(3),
    candidate.edgePct.toFixed(1),
    candidate.bookCount,
    Math.round(candidate.hoursToStart),
  ].join(':')

  let h1 = 0x811C9DC5
  let h2 = 0x01000193
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 + c, 2246822519)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

const SYSTEM_PROMPT = `You review sports betting candidates that a quantitative model has already priced.

You are given, for one selection: the best available decimal price, the model's de-vigged fair probability, the fair probability from sharp books alone, the computed edge, how many books quote it, and how much the three de-vig methods disagree.

Your job is to judge whether the computed edge is likely real or likely an artifact. Real edges in liquid markets are small and rare. Common artifacts:
- Few books quoting, so the "consensus" is one or two opinions.
- High disagreement between de-vig methods, which signals a thin or oddly shaped market.
- A stale price at one book that has not moved with the market.
- A large edge on a longshot, where de-vig methods are least reliable.

Respond with a single JSON object and nothing else:
{"stance":"back"|"lay"|"pass","statedProb":<0..1>,"confidence":<0..1>,"summary":"<one sentence>","rationale":"<2-4 sentences>","caveats":"<newline-separated risks, or empty>"}

statedProb is your own probability for the side described, which will be scored against the outcome. Prefer "pass" when the evidence is thin: declining is not penalised, but a confident wrong call is.`

interface ModelAnswer {
  stance: string
  statedProb: number
  confidence: number
  summary: string
  rationale: string
  caveats: string
}

/**
 * Ask the model about the current candidates and record what it says.
 *
 * A missing key is a no-op rather than an error: the AI layer is an
 * enhancement over a system that is complete without it, and the rest of
 * the pipeline must not fail because an optional credential is absent.
 */
export async function generateInsights(
  db: Database,
  options: { limit?: number, model?: string } = {},
): Promise<InsightResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL

  const candidates = await loadCandidates(db, options.limit ?? MAX_CANDIDATES_PER_RUN)
  const result: InsightResult = {
    requested: candidates.length,
    generated: 0,
    cached: 0,
    skipped: 0,
    costUsd: 0,
    errors: [],
  }

  if (!apiKey) {
    result.skipped = candidates.length
    result.errors.push('ANTHROPIC_API_KEY not set; AI layer dormant')
    return result
  }

  const existing = db.prepare('SELECT id FROM ai_insights WHERE feature_hash = ? AND selection_id = ? LIMIT 1')

  const insert = db.prepare(`
    INSERT INTO ai_insights
      (kind, selection_id, market_event_id, feature_hash, stance, stated_prob, confidence,
      summary, rationale, caveats, model, prompt_tokens, completion_tokens, cost_usd,
      latency_ms, outcome, brier_score, graded_at, created_at, updated_at)
    VALUES ('candidate_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1, 0, '', ?, ?)
  `)

  for (const candidate of candidates) {
    const hash = featureHash(candidate)

    if (await existing.get(hash, candidate.selectionId)) {
      result.cached++
      continue
    }

    const startedAt = Date.now()
    let answer: ModelAnswer | null = null
    let promptTokens = 0
    let completionTokens = 0

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: describeCandidate(candidate) }],
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        result.errors.push(`selection ${candidate.selectionId}: HTTP ${res.status}`)
        result.skipped++
        continue
      }

      const payload = await res.json() as {
        content?: Array<{ text?: string }>
        usage?: { input_tokens?: number, output_tokens?: number }
      }

      promptTokens = payload.usage?.input_tokens ?? 0
      completionTokens = payload.usage?.output_tokens ?? 0
      answer = parseAnswer(payload.content?.[0]?.text ?? '')
    }
    catch (err) {
      result.errors.push(`selection ${candidate.selectionId}: ${err instanceof Error ? err.message : String(err)}`)
      result.skipped++
      continue
    }

    if (!answer) {
      // A model that did not return parseable JSON has said nothing
      // usable. Storing a half-parsed opinion would pollute the track
      // record with rows that were never really predictions.
      result.errors.push(`selection ${candidate.selectionId}: unparseable answer`)
      result.skipped++
      continue
    }

    await insert.run(
      candidate.selectionId,
      candidate.marketEventId,
      hash,
      answer.stance,
      answer.statedProb,
      answer.confidence,
      answer.summary.slice(0, 600),
      answer.rationale,
      answer.caveats.slice(0, 2000),
      model,
      promptTokens,
      completionTokens,
      0,
      Date.now() - startedAt,
      nowIso(),
      nowIso(),
    )
    result.generated++
  }

  return result
}

/** The feature vector, rendered for the model. */
function describeCandidate(c: Candidate): string {
  const lines = [
    `Event: ${c.eventTitle} (${c.league})`,
    `Market: ${c.marketType}${c.line === null ? '' : ` at ${c.line}`}`,
    `Selection: ${c.label} (side: ${c.side})`,
    `Best available decimal price: ${c.bestPrice.toFixed(2)}`,
    `Model fair probability: ${(c.fairProb * 100).toFixed(1)}%`,
    `Sharp-book fair probability: ${c.sharpProb > 0 ? `${(c.sharpProb * 100).toFixed(1)}%` : 'none quoting'}`,
    `Computed edge: ${c.edgePct.toFixed(2)}%`,
    `Books quoting: ${c.bookCount} (${c.sharpBookCount} sharp)`,
    `Market overround: ${c.overroundPct.toFixed(2)}%`,
    `De-vig method disagreement: ${(c.methodSpread * 100).toFixed(2)} points`,
    `Hours until start: ${c.hoursToStart.toFixed(1)}`,
  ]
  return lines.join('\n')
}

/**
 * Parse the model's JSON, tolerating the prose it sometimes wraps around
 * it, and clamping every number into range.
 *
 * Returns null rather than guessing when the shape is wrong. A malformed
 * answer coerced into a default would enter the track record as a real
 * prediction the model never made.
 */
function parseAnswer(text: string): ModelAnswer | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start)
    return null

  let raw: any
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  }
  catch {
    return null
  }

  const stance = ['back', 'lay', 'pass'].includes(raw?.stance) ? raw.stance : null
  if (stance === null)
    return null

  const statedProb = Number(raw?.statedProb)
  const confidence = Number(raw?.confidence)

  return {
    stance,
    statedProb: Number.isFinite(statedProb) ? Math.min(1, Math.max(0, statedProb)) : 0,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    summary: String(raw?.summary ?? ''),
    rationale: String(raw?.rationale ?? ''),
    caveats: String(raw?.caveats ?? ''),
  }
}

/**
 * Score past insights against what happened.
 *
 * A 'pass' stance grades as unknown rather than as a result: declining to
 * call something is neither right nor wrong, and scoring it either way
 * would reward silence or punish restraint. Both are worse than an honest
 * gap in the record.
 */
export async function gradeInsights(db: Database): Promise<number> {
  const pending = await db.query<{ id: number, stance: string, stated_prob: number, outcome: number }>(`
    SELECT a.id, a.stance, a.stated_prob, s.outcome
    FROM ai_insights a
    JOIN selections s ON s.id = a.selection_id
    WHERE a.outcome = -1 AND s.outcome IN (0, 1) AND a.stance != 'pass'
  `).all()

  if (pending.length === 0)
    return 0

  await db.transaction(async (transaction) => {
    const update = transaction.prepare('UPDATE ai_insights SET outcome = ?, brier_score = ?, graded_at = ?, updated_at = ? WHERE id = ?')
    for (const row of pending) {
      // A 'lay' is a call that the side loses, so the model's stated
      // probability refers to the opposite result.
      const predictedHit = row.stance === 'back' ? 1 : 0
      // Numbers, not the strings Vitess hands back for these columns.
      const correct = Number(row.outcome) === predictedHit ? 1 : 0
      const prob = row.stance === 'back' ? Number(row.stated_prob) : 1 - Number(row.stated_prob)
      await update.run(correct, (prob - row.outcome) ** 2, nowIso(), nowIso(), row.id)
    }
  })

  return pending.length
}

export { DEFAULT_MODEL, MAX_CANDIDATES_PER_RUN }
