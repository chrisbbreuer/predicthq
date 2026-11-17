import type { BoxTeam, GameDetail } from '../scores/espn'
import type { LiveGame } from './live-games'
import { cached } from '../prediction-markets/kalshi-public'
import { fetchGame } from '../scores/espn'
import { LEAGUE_PREFIXES } from './live-games'

/**
 * Where a leg stands right now, in the leg's own terms.
 *
 * A player prop is "Zion Williamson: 15+", so the useful number is how
 * many points Zion has. A total is "Over 206.5 points", so it is the
 * combined score. A spread is "Houston wins by over 8.5", so it is
 * Houston's margin. The market's price already says how likely the leg
 * is; this says why, in the number a person watching the game would check.
 */

export interface LegProgress {
  /** Display string, e.g. "22 PTS", "109 pts", "HOU +18". */
  text: string
  current: number
  /** The line the leg needs, when it has one. */
  target: number | null
  /** Share of the way to the line, 0..1, for a progress bar. */
  ratio: number | null
  /** Whether the leg is currently going the holder's way. */
  onTrack: boolean | null
}

/** Box-score columns each prop series counts, and the unit to print. */
const PROP_STATS: Record<string, { columns: string[], unit: string }> = {
  'PTS': { columns: ['PTS'], unit: 'PTS' },
  'REB': { columns: ['REB'], unit: 'REB' },
  'AST': { columns: ['AST'], unit: 'AST' },
  '3PT': { columns: ['3PT'], unit: '3PM' },
  'BLK': { columns: ['BLK'], unit: 'BLK' },
  'STL': { columns: ['STL'], unit: 'STL' },
  'PRA': { columns: ['PTS', 'REB', 'AST'], unit: 'PRA' },
  'PR': { columns: ['PTS', 'REB'], unit: 'P+R' },
  'PA': { columns: ['PTS', 'AST'], unit: 'P+A' },
  'RA': { columns: ['REB', 'AST'], unit: 'R+A' },
}

/** The prop kind a series names (`KXNBAPTS` → `PTS`), or null. */
export function propKind(ticker: string): string | null {
  const series = String(ticker).toUpperCase().split('-')[0] ?? ''
  const prefix = LEAGUE_PREFIXES.find(([p]) => series.startsWith(p))?.[0]
  if (!prefix)
    return null
  const kind = series.slice(prefix.length)
  return PROP_STATS[kind] ? kind : null
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/** A box-score cell as a number; `3PT` is written made-attempted. */
function cell(value: string | undefined): number {
  const first = String(value ?? '').split('-')[0]
  const parsed = Number.parseFloat(first ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** The player a prop names, found in either team's box score. */
export function findPlayer(name: string, teams: Array<BoxTeam | null>): { team: BoxTeam, index: number } | null {
  const wanted = normalize(name)
  const parts = String(name).trim().split(/\s+/)
  const short = parts.length > 1 ? normalize(`${parts[0]![0]}${parts.slice(1).join('')}`) : ''
  for (const team of teams) {
    if (!team)
      continue
    const index = team.players.findIndex(player =>
      normalize(player.name) === wanted || (short && normalize(player.shortName) === short))
    if (index !== -1)
      return { team, index }
  }
  return null
}

/** A prop's current count from the box score. */
export function propProgress(kind: string, label: string, choice: string, box: GameDetail['box']): LegProgress | null {
  const spec = PROP_STATS[kind]
  const match = String(label).match(/^(.+?):\s*(\d+(?:\.\d+)?)\+/)
  if (!spec || !match)
    return null

  const found = findPlayer(match[1]!, [box.away, box.home])
  if (!found)
    return null

  const player = found.team.players[found.index]!
  const current = spec.columns.reduce((sum, column) => {
    const at = found.team.labels.indexOf(column)
    return sum + (at === -1 ? 0 : cell(player.stats[at]))
  }, 0)
  const target = Number(match[2])
  const met = current >= target
  return {
    text: `${current} ${spec.unit}`,
    current,
    target,
    ratio: target > 0 ? Math.min(1, current / target) : null,
    onTrack: choice === 'no' ? !met : met,
  }
}

/** A total's combined score against its line. */
export function totalProgress(label: string, choice: string, game: LiveGame): LegProgress | null {
  const match = String(label).match(/\b(over|under)\s+(\d+(?:\.\d+)?)/i)
  if (!match || game.home.score === null || game.away.score === null)
    return null
  const current = game.home.score + game.away.score
  const target = Number(match[2])
  const over = match[1]!.toLowerCase() === 'over'
  const met = over ? current > target : current < target
  return {
    text: `${current} pts`,
    current,
    target,
    ratio: over && target > 0 ? Math.min(1, current / target) : null,
    onTrack: choice === 'no' ? !met : met,
  }
}

/** A spread's current margin for the team it names. */
export function spreadProgress(label: string, choice: string, game: LiveGame): LegProgress | null {
  const match = String(label).match(/^(.+?)\s+wins by (?:over|more than)\s+(\d+(?:\.\d+)?)/i)
  if (!match || game.home.score === null || game.away.score === null)
    return null
  const wanted = normalize(match[1])
  const named = (team: LiveGame['home']) => [team.location, team.name, team.abbreviation].some(value => normalize(value) === wanted)
  const side = named(game.home) ? 'home' : (named(game.away) ? 'away' : null)
  if (!side)
    return null
  const mine = game[side]
  const theirs = game[side === 'home' ? 'away' : 'home']
  const margin = (mine.score ?? 0) - (theirs.score ?? 0)
  const target = Number(match[2])
  const met = margin > target
  return {
    text: `${mine.abbreviation} ${margin > 0 ? '+' : ''}${margin}`,
    current: margin,
    target,
    ratio: target > 0 ? Math.max(0, Math.min(1, margin / target)) : null,
    onTrack: choice === 'no' ? !met : met,
  }
}

/** One game's full detail, briefly cached and shared across legs. */
export function gameDetail(league: string, id: string, loader: typeof fetchGame = fetchGame): Promise<GameDetail | null> {
  return cached(`espn-game:${league}:${id}`, 12_000, () => loader(league, id))
}

/**
 * Progress for one leg, or null when there is nothing to count yet: the
 * game has not started, or the leg is a plain winner market whose score
 * the card already shows.
 */
export async function legProgress(
  ticker: string,
  label: string,
  choice: string,
  game: LiveGame | null,
  loader: typeof fetchGame = fetchGame,
): Promise<LegProgress | null> {
  if (!game || game.state === 'pre')
    return null

  const series = String(ticker).toUpperCase().split('-')[0] ?? ''
  if (/TOTAL$/.test(series))
    return totalProgress(label, choice, game)
  if (/SPREAD$/.test(series))
    return spreadProgress(label, choice, game)

  const kind = propKind(ticker)
  if (!kind)
    return null
  const detail = await gameDetail(game.league, game.gameId, loader).catch(() => null)
  return detail ? propProgress(kind, label, choice, detail.box) : null
}
