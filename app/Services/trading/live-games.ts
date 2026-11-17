import type { Game, Team } from '../scores/espn'
import { cached } from '../prediction-markets/kalshi-public'
import { fetchScoreboard } from '../scores/espn'

/**
 * From a Kalshi ticker to the game it is about, and that game's score.
 *
 * Kalshi names every per-game market the same way:
 *
 *   KXNBAGAME-26NOV16ORLBOS-BOS
 *   └ series ┘ └date┘└code┘ └outcome
 *
 * The series says which league, the date is the game's local (Eastern)
 * date, and the code is the two teams' abbreviations run together. That
 * is enough to find the game on ESPN's scoreboard for that day without
 * any free-text guessing, which is what makes a position's live score
 * trustworthy rather than "probably the right Boston".
 *
 * Player props, spreads, and totals share the same event shape
 * (`KXNBAPTS-26NOV16ORLBOS-…`), so they match the same game; only winner
 * markets name a team the holder is rooting for.
 */

export interface GameTickerRef {
  series: string
  league: string
  /** ESPN's `YYYYMMDD`. */
  date: string
  /** Team abbreviations run together, e.g. `ORLBOS`. */
  code: string
  /** What follows the event, e.g. `BOS`, `BOS6`, `220`. */
  outcome: string
  eventTicker: string
  /** True for series whose YES is "this team wins the game". */
  winner: boolean
}

export interface LiveTeam {
  abbreviation: string
  name: string
  location: string
  logo: string
  color: string
  score: number | null
  record: string | null
}

export interface LiveGame {
  league: string
  gameId: string
  gameUrl: string
  /** 'pre' | 'in' | 'post' */
  state: string
  status: string
  clock: string
  period: number | null
  lastPlay: string
  startsAt: string
  home: LiveTeam
  away: LiveTeam
  /** Which side the market's YES names, when it names one. */
  selected: 'home' | 'away' | null
  /** Which side the holder needs to win, after applying YES/NO. */
  rooting: 'home' | 'away' | null
  /** 'Ahead' | 'Behind' | 'Tied' | 'Won' | 'Lost' | 'Live' | 'Scheduled' | 'Final' */
  standing: string
  /** 'pos' | 'neg' | 'muted' | 'live' */
  tone: string
}

/**
 * League by series prefix. Order matters only where one prefix contains
 * another, and none of these do: `KXWNBA` does not start with `KXNBA`.
 */
const LEAGUE_PREFIXES: Array<[string, string]> = [
  ['KXNCAAMB', 'ncaab'],
  ['KXNCAAWB', 'ncaaw'],
  ['KXUEFANL', 'uefa-nations'],
  ['KXUCL', 'ucl'],
  ['KXLALIGA', 'laliga'],
  ['KXSERIEA', 'seriea'],
  ['KXBUNDESLIGA', 'bundesliga'],
  ['KXLIGUE1', 'ligue1'],
  ['KXNCAAF', 'ncaaf'],
  ['KXWNBA', 'wnba'],
  ['KXNBA', 'nba'],
  ['KXNFL', 'nfl'],
  ['KXNHL', 'nhl'],
  ['KXMLB', 'mlb'],
  ['KXMLS', 'mls'],
  ['KXEPL', 'epl'],
]

const MONTHS: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
}

/** Parse a per-game Kalshi ticker, or null when it is not one. */
export function parseGameTicker(ticker: unknown): GameTickerRef | null {
  const text = String(ticker ?? '').trim().toUpperCase()
  const [series = '', event = '', ...rest] = text.split('-')
  const league = LEAGUE_PREFIXES.find(([prefix]) => series.startsWith(prefix))?.[1]
  if (!league)
    return null

  // Date, an optional HHMM start for doubleheaders, then the team code.
  const match = event.match(/^(\d{2})([A-Z]{3})(\d{2})(?:\d{4})?([A-Z]{4,12})$/)
  if (!match)
    return null

  const month = MONTHS[match[2]!]
  if (!month)
    return null

  return {
    series,
    league,
    date: `20${match[1]}${month}${match[3]}`,
    code: match[4]!,
    outcome: rest.join('-'),
    eventTicker: `${series}-${event}`,
    // Winner markets only: quarter/half winners resolve on part of the
    // game, so they are not "this team wins" in the sense a score shows.
    winner: /GAME$/.test(series),
  }
}

/**
 * Where ESPN and Kalshi spell a team differently. Prefix matching covers
 * most of it (`GS`/`GSW`, `NO`/`NOP`); these are the ones it cannot.
 */
const ABBREVIATION_ALIASES: Record<string, string[]> = {
  WSH: ['WAS'],
  WAS: ['WSH'],
  UTAH: ['UTA'],
  UTA: ['UTAH'],
  LA: ['LAK', 'LAR', 'LAC'],
  JAX: ['JAC'],
  CHW: ['CWS'],
  CWS: ['CHW'],
  AZ: ['ARI'],
  ARI: ['AZ'],
}

function abbreviationsOf(team: Team): string[] {
  const own = String(team.abbreviation ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  return own ? [own, ...(ABBREVIATION_ALIASES[own] ?? [])] : []
}

/** Does `part` (from a Kalshi code) name `team`? */
function names(part: string, team: Team): boolean {
  if (!part)
    return false
  return abbreviationsOf(team).some(abbr =>
    abbr === part
    || (abbr.length >= 2 && part.startsWith(abbr) && part.length - abbr.length <= 1)
    || (part.length >= 2 && abbr.startsWith(part) && abbr.length - part.length <= 1))
}

/**
 * Split a code into two team abbreviations that match this game, in
 * either order. Returns which side each half named, or null.
 */
function splitCode(code: string, game: Game): boolean {
  for (let i = 2; i <= code.length - 2; i++) {
    const first = code.slice(0, i)
    const second = code.slice(i)
    if ((names(first, game.away) && names(second, game.home)) || (names(first, game.home) && names(second, game.away)))
      return true
  }
  return false
}

/** Which side an outcome suffix (`BOS`, `BOS6`) names, if either. */
export function sideForOutcome(outcome: string, game: Game, hint = ''): 'home' | 'away' | null {
  const letters = outcome.toUpperCase().replace(/[^A-Z]/g, '')
  if (!letters)
    return null
  const home = names(letters, game.home)
  const away = names(letters, game.away)
  if (home && !away)
    return 'home'
  if (away && !home)
    return 'away'
  // The code did not say; the market's wording may ("Missouri St.").
  const wanted = normalizeName(hint)
  if (wanted.length >= 3) {
    const byName = (team: Team) => [team.location, team.shortName, team.name].map(normalizeName).some(name => name.length >= 3 && wanted === name)
    if (byName(game.home) && !byName(game.away))
      return 'home'
    if (byName(game.away) && !byName(game.home))
      return 'away'
  }
  return null
}

/** Lowercase letters and digits only, with `St.` read as `State`. */
function normalizeName(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\b\.?/g, 'state')
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * The game a market's wording names, when exactly one of the day's games
 * fits. College codes are the reason this exists: Kalshi writes Abilene
 * Christian at Missouri State as `ACMOSU` where ESPN has `ACU` and `MOST`,
 * but the market itself says "Missouri St.", which is unambiguous.
 */
function gameByName(hint: string, games: Game[]): Game | null {
  const wanted = normalizeName(hint)
  if (wanted.length < 3)
    return null
  const names = (team: Team) => [team.location, team.shortName, team.name].map(normalizeName).filter(name => name.length >= 3)
  const hits = games.filter(game => [game.home, game.away].some(team =>
    names(team).some(name => wanted === name || (name.length >= 5 && wanted.startsWith(name)))))
  return hits.length === 1 ? hits[0]! : null
}

/**
 * Find the game a parsed ticker is about among one day's games: by the
 * team code first, then by the market's own wording (`hint`, e.g. its
 * outcome label) when the code is spelled in a way ESPN does not use.
 */
export function matchGame(ref: GameTickerRef, games: Game[], hint = ''): Game | null {
  return games.find(game => splitCode(ref.code, game)) ?? (hint ? gameByName(hint, games) : null)
}

function liveTeam(team: Team): LiveTeam {
  return {
    abbreviation: team.abbreviation,
    name: team.name,
    location: team.location || team.shortName,
    logo: team.logo ?? '',
    color: team.color ?? '',
    score: team.score,
    record: team.record,
  }
}

/**
 * The card for one game from one holder's point of view.
 *
 * `rooting` is the side the holder needs: YES on "Boston wins" roots for
 * Boston, NO on it roots for Orlando. Standing is only computed for winner
 * markets, because "ahead" means nothing for a player prop or a total.
 */
export function liveGameCard(game: Game, ref: GameTickerRef | null, side: string, hint = ''): LiveGame {
  const selected = ref && ref.winner ? sideForOutcome(ref.outcome, game, hint) : null
  const rooting = selected === null
    ? null
    : (String(side).toLowerCase() === 'no' ? (selected === 'home' ? 'away' : 'home') : selected)

  return {
    league: game.league,
    gameId: game.id,
    gameUrl: `/scores/${game.league}/game/${game.id}`,
    state: game.state,
    status: game.status,
    clock: game.clock,
    period: typeof game.period === 'number' ? game.period : null,
    lastPlay: game.lastPlay ?? '',
    startsAt: game.startsAt,
    home: liveTeam(game.home),
    away: liveTeam(game.away),
    selected,
    rooting,
    ...standingFor(game, rooting),
  }
}

function standingFor(game: Game, rooting: 'home' | 'away' | null): { standing: string, tone: string } {
  if (game.state === 'pre')
    return { standing: 'Scheduled', tone: 'muted' }

  const mine = rooting === null ? null : game[rooting]
  const theirs = rooting === null ? null : game[rooting === 'home' ? 'away' : 'home']
  if (!mine || !theirs || mine.score === null || theirs.score === null)
    return game.state === 'post' ? { standing: 'Final', tone: 'muted' } : { standing: 'Live', tone: 'live' }

  const margin = mine.score - theirs.score
  if (game.state === 'post')
    return margin > 0 ? { standing: 'Won', tone: 'pos' } : (margin < 0 ? { standing: 'Lost', tone: 'neg' } : { standing: 'Final', tone: 'muted' })
  if (margin > 0)
    return { standing: 'Ahead', tone: 'pos' }
  if (margin < 0)
    return { standing: 'Behind', tone: 'neg' }
  return { standing: 'Tied', tone: 'muted' }
}

/**
 * One league's games for one day, briefly cached. Every holding on the
 * same night shares one read, and a polling page does not turn into a
 * polling ESPN.
 */
export function gamesOn(league: string, date: string, loader: typeof fetchScoreboard = fetchScoreboard): Promise<Game[]> {
  return cached(`espn:${league}:${date}`, 8_000, () => loader(league, date))
}

/** Resolve a ticker to its game card, or null when it is not a game. */
export async function liveGameFor(
  ticker: string,
  side: string,
  loader: typeof fetchScoreboard = fetchScoreboard,
  hint = '',
): Promise<LiveGame | null> {
  const ref = parseGameTicker(ticker)
  if (!ref)
    return null

  const games = await gamesOn(ref.league, ref.date, loader).catch(() => [] as Game[])
  const game = matchGame(ref, games, hint)
  return game ? liveGameCard(game, ref, side, hint) : null
}
