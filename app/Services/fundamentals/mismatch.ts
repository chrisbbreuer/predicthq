import { injuryReport } from './injuries'
import type { Database } from '../../Support/db'

/**
 * How lopsided is this fixture, on evidence the bookmaker did not supply?
 *
 * Every other input in this system is derived from book quotes, so the
 * model can only ever restate what the books already think. This is the
 * one read that can contradict them, which makes it the only input
 * capable of finding a genuinely mispriced game rather than a
 * well-priced one with a wide margin.
 *
 * Three sources, in descending order of how much they settle the
 * question:
 *
 *  1. **League tier.** A fourth-division side against a first-division
 *     side is decided before anyone looks at form. It is also the
 *     cheapest field to source and survives a club having no valuation.
 *  2. **Squad value.** Within a tier, money is the best available proxy
 *     for depth, and the ratio matters rather than the difference: a
 *     €900m squad against a €450m one is the same story at any scale.
 *  3. **Record and scoring differential.** Sensitive to form the other
 *     two miss entirely, and the only one available outside soccer.
 *
 * The output is a signed 0..1 strength edge for the home side, and
 * deliberately NOT a probability. Turning it into one requires knowing
 * how much a tier gap is worth in each competition, which is a question
 * only settled results can answer. Until `calibration_buckets` has that
 * history this is an ordering, and the caller decides what to do with it.
 */

export interface TeamFundamentals {
  teamId: number
  leagueTier: number
  squadValueEur: number
  winPercent: number
  pointDifferential: number
  gamesPlayed: number
  /** Summed severity of listed absences. */
  injuryBurden: number
  injuriesKnown?: boolean
  hasStanding: boolean
  hasValuation: boolean
}

export interface Mismatch {
  /** −1..1. Positive favours home. */
  edge: number
  /** 0..1. How much of the edge rests on data that is actually present. */
  confidence: number
  /** One line per contributing source, for the evidence trail. */
  reasons: string[]
}

const EMPTY: Mismatch = { edge: 0, confidence: 0, reasons: [] }

export async function loadTeamFundamentals(db: Database, teamId: number): Promise<TeamFundamentals> {
  const [standing, valuation, league, injuries] = await Promise.all([
    db.query<any>(`
    SELECT win_percent, point_differential, games_played
    FROM team_standings WHERE sports_team_id = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(teamId),

    db.query<any>(`
    SELECT squad_value_eur, league_tier
    FROM club_valuations WHERE sports_team_id = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(teamId),

  // Tier from the league the club is ingested under. This is free and
  // covers every side in a cup tie, because a club's division is simply
  // which feed it appears in. A valuation row overrides it when a paid
  // source knows the club better, but nothing has to be configured for
  // the tier gap that decides most mismatches to be visible.
    db.query<any>(`
    SELECT sp.tier FROM sports_teams t JOIN sports sp ON sp.id = t.sport_id
    WHERE t.id = ?
    `).get(teamId),

    injuryReport(db, teamId),
  ])

  return {
    teamId,
    leagueTier: Number(valuation?.league_tier || league?.tier || 0),
    squadValueEur: Number(valuation?.squad_value_eur ?? 0),
    winPercent: Number(standing?.win_percent ?? 0),
    pointDifferential: Number(standing?.point_differential ?? 0),
    gamesPlayed: Number(standing?.games_played ?? 0),
    injuryBurden: injuries.known ? injuries.injuries.reduce((sum, injury) => sum + injury.severity, 0) : 0,
    injuriesKnown: injuries.known,
    hasStanding: Boolean(standing),
    hasValuation: Boolean(valuation) || Number(league?.tier ?? 0) > 0,
  }
}

/** Squash an unbounded ratio into −1..1 without a cliff at the edges. */
function squash(value: number, scale: number): number {
  return Math.tanh(value / scale)
}

export function assessMismatch(home: TeamFundamentals, away: TeamFundamentals): Mismatch {
  const parts: Array<{ edge: number, weight: number, reason: string }> = []

  // 1. Tier. A gap here outweighs everything else, which is why it
  // carries the largest weight and saturates after three divisions:
  // first against fourth and first against seventh are both simply
  // "no contest", and pretending otherwise would overstate the edge.
  if (home.leagueTier > 0 && away.leagueTier > 0 && home.leagueTier !== away.leagueTier) {
    const gap = away.leagueTier - home.leagueTier
    parts.push({
      edge: Math.max(-1, Math.min(1, gap / 3)),
      weight: 3,
      reason: `Tier ${home.leagueTier} vs tier ${away.leagueTier}`,
    })
  }

  // 2. Squad value, on a log ratio so scale does not distort it.
  if (home.squadValueEur > 0 && away.squadValueEur > 0) {
    const ratio = Math.log(home.squadValueEur / away.squadValueEur)
    parts.push({
      edge: squash(ratio, 1.6),
      weight: 2,
      reason: `Squad value ${formatEur(home.squadValueEur)} vs ${formatEur(away.squadValueEur)}`,
    })
  }

  // 3. Form. Gated on a real sample: a 2-0 start says almost nothing, and
  // early-season noise is exactly where a naive model finds fake edges.
  const played = Math.min(home.gamesPlayed, away.gamesPlayed)
  if (home.hasStanding && away.hasStanding && played >= 10) {
    parts.push({
      edge: Math.max(-1, Math.min(1, (home.winPercent - away.winPercent) * 2)),
      weight: 1.5,
      reason: `Record ${(home.winPercent * 100).toFixed(0)}% vs ${(away.winPercent * 100).toFixed(0)}%`,
    })

    const perGame = (home.pointDifferential - away.pointDifferential) / Math.max(1, played)
    parts.push({
      edge: squash(perGame, 1.5),
      weight: 1,
      reason: `Scoring differential ${signed(home.pointDifferential)} vs ${signed(away.pointDifferential)}`,
    })
  }

  // 4. Availability, as a nudge rather than a driver. Severity is a coarse
  // reading of prose and the count says nothing about who is missing, so
  // a heavy list moves the number a little and never carries a call.
  const burdenGap = away.injuryBurden - home.injuryBurden
  if (home.injuriesKnown !== false && away.injuriesKnown !== false && Math.abs(burdenGap) >= 2) {
    parts.push({
      edge: squash(burdenGap, 8),
      weight: 0.5,
      reason: `Absences ${home.injuryBurden.toFixed(1)} vs ${away.injuryBurden.toFixed(1)}`,
    })
  }

  if (parts.length === 0)
    return EMPTY

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)

  // Divide by a floor, not by the weight actually present. Normalising by
  // the sum alone cancels the weights out whenever one source speaks by
  // itself: the injury nudge, weighted 0.5, became 0.5/0.5 and returned
  // its full edge, so a fixture we knew nothing about except who was hurt
  // produced a confident call off the weakest evidence in the system.
  //
  // The floor is the tier weight, because a tier gap genuinely is
  // decisive on its own and should not be damped, while anything lighter
  // has to clear that bar before it can move the number much.
  const WEIGHT_FLOOR = 3
  const edge = parts.reduce((sum, p) => sum + p.edge * p.weight, 0) / Math.max(totalWeight, WEIGHT_FLOOR)

  // Confidence is how much of the available evidence actually spoke, not
  // how large the edge is. A big number resting on one source is exactly
  // the case that should be distrusted.
  const maxWeight = 8
  const confidence = Math.min(1, totalWeight / maxWeight)

  return {
    edge: Math.max(-1, Math.min(1, edge)),
    confidence,
    reasons: parts.map(p => p.reason),
  }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`
}

function formatEur(value: number): string {
  if (value >= 1e9)
    return `€${(value / 1e9).toFixed(2)}bn`
  if (value >= 1e6)
    return `€${(value / 1e6).toFixed(0)}m`
  return `€${Math.round(value / 1e3)}k`
}
