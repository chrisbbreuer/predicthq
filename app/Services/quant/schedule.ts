import type { Database } from '../../Support/db'

/**
 * Rest and congestion, derived from fixtures we already hold.
 *
 * No new source: every input here comes from `market_events.commence_at`
 * and the two team ids already on each row. That is worth stating because
 * it was sitting unused while the model priced games on bookmaker quotes
 * alone, and in the compressed calendars — a back-to-back in the NBA, a
 * third game in five nights in the NHL — the effect is among the largest
 * and best documented in sport.
 *
 * Books price rest, but slowly and unevenly, especially on the second
 * night of a back-to-back for the road side. That lag is the opportunity.
 *
 * Everything is measured strictly before kickoff. A query that counted a
 * team's own result would leak the outcome into a feature meant to
 * predict it, which backtests beautifully and fails live.
 */

/** Games this many days back count toward congestion. */
const CONGESTION_WINDOW_DAYS = 7

/** Beyond this, more rest stops helping and starts meaning rust. */
const MAX_USEFUL_REST_DAYS = 4

export interface ScheduleContext {
  teamId: number
  /** Days since this team's previous fixture. Null when we have no history. */
  restDays: number | null
  /** Fixtures played in the congestion window before this one. */
  gamesInWindow: number
  /** True when the previous fixture was the day before or same day. */
  backToBack: boolean
}

export interface ScheduleEdge {
  /** −1..1, positive favours home. */
  edge: number
  confidence: number
  reasons: string[]
}

const EMPTY: ScheduleEdge = { edge: 0, confidence: 0, reasons: [] }

/**
 * A team's schedule as it stood going into one fixture.
 *
 * `commence_at < ?` rather than `<=`, so the fixture being priced is
 * never counted as its own history.
 */
export async function loadScheduleContext(db: Database, teamId: number, commenceAt: string): Promise<ScheduleContext> {
  if (!commenceAt) {
    return { teamId, restDays: null, gamesInWindow: 0, backToBack: false }
  }

  const previous = await db.query<{ commence_at: string }>(`
    SELECT commence_at
    FROM market_events
    WHERE (home_sports_team_id = ? OR away_sports_team_id = ?)
      AND status NOT IN ('cancelled', 'postponed')
      AND commence_at != '' AND commence_at < ?
    ORDER BY commence_at DESC
    LIMIT 1
  `).get(teamId, teamId, commenceAt)

  const windowStart = new Date(Date.parse(commenceAt) - CONGESTION_WINDOW_DAYS * 86_400_000).toISOString()

  const congestion = await db.query<{ games: number }>(`
    SELECT COUNT(*) AS games
    FROM market_events
    WHERE (home_sports_team_id = ? OR away_sports_team_id = ?)
      AND status NOT IN ('cancelled', 'postponed')
      AND commence_at != '' AND commence_at < ? AND commence_at >= ?
  `).get(teamId, teamId, commenceAt, windowStart)

  let restDays: number | null = null
  if (previous?.commence_at) {
    const gap = Date.parse(commenceAt) - Date.parse(previous.commence_at)
    if (Number.isFinite(gap))
      restDays = Math.max(0, gap / 86_400_000)
  }

  return {
    teamId,
    restDays,
    gamesInWindow: Number(congestion?.games ?? 0),
    // Under 36 hours covers a genuine back-to-back without catching an
    // evening game followed by one two nights later.
    backToBack: restDays !== null && restDays < 1.5,
  }
}

/**
 * Turn two schedule contexts into a signed edge for the home side.
 *
 * Rest is capped before it is compared: the gap between one day and three
 * is real, the gap between eight and ten is not, and letting a team on a
 * long break look ever fresher would invent an edge out of a bye week.
 */
export function assessScheduleEdge(home: ScheduleContext, away: ScheduleContext): ScheduleEdge {
  const reasons: string[] = []
  let edge = 0
  let weight = 0

  if (home.restDays !== null && away.restDays !== null) {
    const homeRest = Math.min(home.restDays, MAX_USEFUL_REST_DAYS)
    const awayRest = Math.min(away.restDays, MAX_USEFUL_REST_DAYS)
    const gap = homeRest - awayRest

    if (Math.abs(gap) >= 1) {
      // Scaled so a full three-day advantage approaches the cap rather
      // than reaching it. This is a real effect and a modest one.
      edge += Math.max(-1, Math.min(1, gap / 3))
      weight += 2
      reasons.push(`Rest ${homeRest.toFixed(0)}d vs ${awayRest.toFixed(0)}d`)
    }

    // A back-to-back is worth calling out separately: it is not just less
    // rest, it is the specific case books are slowest to price.
    if (home.backToBack !== away.backToBack) {
      edge += home.backToBack ? -0.5 : 0.5
      weight += 1.5
      reasons.push(home.backToBack ? 'Home on a back-to-back' : 'Away on a back-to-back')
    }
  }

  const congestionGap = away.gamesInWindow - home.gamesInWindow
  if (Math.abs(congestionGap) >= 2) {
    edge += Math.max(-1, Math.min(1, congestionGap / 3))
    weight += 1
    reasons.push(`Games in ${CONGESTION_WINDOW_DAYS}d: ${home.gamesInWindow} vs ${away.gamesInWindow}`)
  }

  if (weight === 0)
    return EMPTY

  // Same floor discipline as the mismatch read: dividing by the weight
  // actually present would let a single light source return its full
  // edge, which is how a lone congestion count would end up shouting.
  const WEIGHT_FLOOR = 3

  return {
    edge: Math.max(-1, Math.min(1, edge / Math.max(weight, WEIGHT_FLOOR))),
    confidence: Math.min(1, weight / 4.5),
    reasons,
  }
}
