import type { Game, Team } from '../scores/espn'
import { fetchScoreboard } from '../scores/espn'

export interface TrackableHolding {
  venue: string
  marketExternalId: string
  side: string
  question: string
  outcomeLabel: string
  endsAt: string
}

export interface MultiGameLeg {
  choice: 'yes' | 'no'
  team: string
}

export interface PositionScoreLeg extends MultiGameLeg {
  found: boolean
  gameId: string
  gameUrl: string
  state: string
  status: string
  clock: string
  startsAt: string
  selectedScore: number | null
  opponentScore: number | null
  opponent: string
  standing: string
  tone: string
}

export interface PositionScorecard {
  total: number
  found: number
  live: number
  final: number
  upcoming: number
  missing: number
  legs: PositionScoreLeg[]
}

interface ScorecardOptions {
  now?: Date
  loadScoreboard?: typeof fetchScoreboard
}

interface ScoreboardCache {
  key: string
  expiresAt: number
  promise: Promise<Game[]>
}

const SCORE_CACHE_MS = 8_000
let scoreboardCache: ScoreboardCache | null = null

/**
 * Kalshi multi-event contracts write one comma-separated condition per leg:
 * `yes LSU,yes New Mexico,...`. A single-outcome label is not a scorecard.
 */
export function parseMultiGameLegs(value: unknown): MultiGameLeg[] {
  const legs = String(value ?? '').split(',').flatMap((part) => {
    const match = part.trim().match(/^(yes|no)\s+(.+)$/i)
    if (!match)
      return []

    const team = String(match[2] ?? '').trim()
    if (!team)
      return []

    return [{ choice: String(match[1]).toLowerCase() as 'yes' | 'no', team }]
  })

  return legs.length > 1 ? legs : []
}

/** Normalize punctuation plus the abbreviations the two feeds disagree on. */
export function normalizeTeamName(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(token => token === 'st' ? 'state' : token)
    .join('')
}

export function scorecardKey(holding: Pick<TrackableHolding, 'venue' | 'marketExternalId' | 'side'>): string {
  return `${holding.venue}:${holding.marketExternalId}:${holding.side}`
}

function aliases(team: Team): Set<string> {
  return new Set([
    normalizeTeamName(team.location),
    normalizeTeamName(team.shortName),
    normalizeTeamName(team.abbreviation),
    normalizeTeamName(team.name),
  ].filter(Boolean))
}

function gameFor(team: string, games: Game[], now: Date): { game: Game, selected: Team, opponent: Team } | null {
  const wanted = normalizeTeamName(team)
  if (!wanted)
    return null

  const matches = games.flatMap((game) => {
    if (aliases(game.home).has(wanted))
      return [{ game, selected: game.home, opponent: game.away }]
    if (aliases(game.away).has(wanted))
      return [{ game, selected: game.away, opponent: game.home }]
    return []
  })

  if (matches.length === 0)
    return null

  // A range can contain two games for one school. The one closest to now is
  // the useful one while the contract is open, and avoids stale prior-week
  // scores winning only because they appeared first in ESPN's response.
  return matches.sort((a, b) => distanceFrom(a.game.startsAt, now) - distanceFrom(b.game.startsAt, now))[0] ?? null
}

function distanceFrom(value: string, now: Date): number {
  const instant = Date.parse(value)
  return Number.isFinite(instant) ? Math.abs(instant - now.getTime()) : Number.MAX_SAFE_INTEGER
}

function scoreStanding(choice: 'yes' | 'no', game: Game, selected: Team, opponent: Team): { label: string, tone: string } {
  if (game.state === 'pre')
    return { label: 'Scheduled', tone: 'muted' }

  if (selected.score === null || opponent.score === null)
    return { label: game.state === 'post' ? 'Final' : 'Live', tone: game.state === 'in' ? 'live' : 'muted' }

  const margin = selected.score - opponent.score
  const conditionMargin = choice === 'yes' ? margin : -margin

  if (game.state === 'post')
    return conditionMargin > 0 ? { label: 'Won', tone: 'pos' } : { label: 'Lost', tone: 'neg' }
  if (conditionMargin > 0)
    return { label: 'Ahead', tone: 'pos' }
  if (conditionMargin < 0)
    return { label: 'Behind', tone: 'neg' }
  return { label: 'Tied', tone: 'muted' }
}

export function buildPositionScorecard(legs: MultiGameLeg[], games: Game[], now = new Date()): PositionScorecard {
  const resolved = legs.map((leg): PositionScoreLeg => {
    const match = gameFor(leg.team, games, now)
    if (!match) {
      return {
        ...leg,
        found: false,
        gameId: '',
        gameUrl: '',
        state: 'missing',
        status: 'Score not found yet',
        clock: '',
        startsAt: '',
        selectedScore: null,
        opponentScore: null,
        opponent: '',
        standing: 'Waiting',
        tone: 'muted',
      }
    }

    const { game, selected, opponent } = match
    const standing = scoreStanding(leg.choice, game, selected, opponent)
    return {
      ...leg,
      found: true,
      gameId: game.id,
      gameUrl: `/scores/${game.league}/game/${game.id}`,
      state: game.state,
      status: game.status,
      clock: game.clock,
      startsAt: game.startsAt,
      selectedScore: selected.score,
      opponentScore: opponent.score,
      opponent: opponent.location || opponent.shortName || opponent.name,
      standing: standing.label,
      tone: standing.tone,
    }
  })

  return {
    total: resolved.length,
    found: resolved.filter(leg => leg.found).length,
    live: resolved.filter(leg => leg.state === 'in').length,
    final: resolved.filter(leg => leg.state === 'post').length,
    upcoming: resolved.filter(leg => leg.state === 'pre').length,
    missing: resolved.filter(leg => !leg.found).length,
    legs: resolved,
  }
}

/**
 * Scorecards for multi-game holdings only. The caller has already performed
 * the authenticated ownership query; this function never accepts a ticker
 * from the public request.
 */
export async function positionScorecards(
  holdings: TrackableHolding[],
  options: ScorecardOptions = {},
): Promise<Map<string, PositionScorecard>> {
  const candidates = holdings.flatMap((holding) => {
    const legs = parseMultiGameLegs(holding.outcomeLabel || holding.question)
    return legs.length > 1 ? [{ holding, legs }] : []
  })
  if (candidates.length === 0)
    return new Map()

  const now = options.now ?? new Date()
  const range = scoreboardRange(candidates.map(candidate => candidate.holding.endsAt), now)
  const loader = options.loadScoreboard ?? fetchScoreboard
  const games = options.loadScoreboard
    ? await loader('ncaaf', range)
    : await cachedScoreboard(range, loader)

  return new Map(candidates.map(({ holding, legs }) => [
    scorecardKey(holding),
    buildPositionScorecard(legs, games, now),
  ]))
}

function scoreboardRange(endValues: string[], now: Date): string {
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - 1)

  const latestAllowed = new Date(now)
  latestAllowed.setUTCDate(latestAllowed.getUTCDate() + 7)
  let end = new Date(now)
  end.setUTCDate(end.getUTCDate() + 1)

  for (const value of endValues) {
    const parsed = new Date(value)
    if (!Number.isFinite(parsed.getTime()))
      continue
    if (parsed > end)
      end = parsed
  }

  if (end > latestAllowed)
    end = latestAllowed

  return `${espnDate(start)}-${espnDate(end)}`
}

function espnDate(value: Date): string {
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`
}

function cachedScoreboard(range: string, loader: typeof fetchScoreboard): Promise<Game[]> {
  const now = Date.now()
  if (scoreboardCache?.key === range && scoreboardCache.expiresAt > now)
    return scoreboardCache.promise

  const promise = loader('ncaaf', range).catch(() => [])
  scoreboardCache = { key: range, expiresAt: now + SCORE_CACHE_MS, promise }
  return promise
}
