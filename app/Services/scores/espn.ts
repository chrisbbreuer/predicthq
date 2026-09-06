/**
 * ESPN scoreboard client.
 *
 * ESPN's site API is public but undocumented: no key, no rate-limit
 * headers, no stability guarantee. That is the trade we accepted to get
 * live scores today, and it shapes the code. Every read is defensive,
 * every field optional, and a shape change degrades to fewer games rather
 * than a stack trace on the page.
 *
 * Swapping to a paid feed later means reimplementing `fetchScoreboard`
 * and nothing else, which is why the normalised types below are ours
 * rather than ESPN's.
 */

export interface Team {
  abbreviation: string
  /** School/city name without the mascot, useful when matching venue legs. */
  location: string
  name: string
  shortName: string
  logo: string | null
  score: number | null
  record: string | null
  winner: boolean
}

export interface Game {
  id: string
  league: string
  startsAt: string
  /** 'pre' | 'in' | 'post' — ESPN's own state vocabulary, kept as-is. */
  state: string
  /** "Final", "2nd Quarter", "Scheduled". */
  status: string
  /** "7:32 - 2nd" while live, empty otherwise. */
  clock: string
  venue: string | null
  broadcast: string | null
  home: Team
  away: Team
}

export interface League {
  key: string
  label: string
  /** ESPN's `{sport}/{league}` path segment. */
  path: string
  /** College football is split across FBS and FCS scoreboards. */
  groups?: string[]
  /** ESPN silently falls back to 25 when an excessive limit is requested. */
  limit?: number
}

/**
 * The leagues offered in the switcher.
 *
 * Deliberately short. Every entry is a live network call, and a switcher
 * with thirty options is a menu rather than a product decision.
 */
export const LEAGUES: League[] = [
  { key: 'nfl', label: 'NFL', path: 'football/nfl' },
  { key: 'ncaaf', label: 'College Football', path: 'football/college-football', groups: ['80', '81'], limit: 100 },
  { key: 'nba', label: 'NBA', path: 'basketball/nba' },
  { key: 'mlb', label: 'MLB', path: 'baseball/mlb' },
  { key: 'nhl', label: 'NHL', path: 'hockey/nhl' },
  { key: 'epl', label: 'Premier League', path: 'soccer/eng.1' },
  { key: 'atp', label: 'Tennis', path: 'tennis/atp' },
]

export function leagueFor(key: string): League {
  return LEAGUES.find(l => l.key === key) ?? LEAGUES[0]!
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toTeam(competitor: any): Team {
  const team = competitor?.team ?? {}
  return {
    abbreviation: String(team.abbreviation ?? '').slice(0, 5),
    location: String(team.location ?? ''),
    name: String(team.displayName ?? team.name ?? 'Unknown'),
    shortName: String(team.shortDisplayName ?? team.abbreviation ?? ''),
    // The scoreboard exposes `logo`; the summary header exposes `logos[]`
    // instead, so a detail page reading only the former rendered no crests.
    logo: typeof team.logo === 'string'
      ? team.logo
      : (typeof team.logos?.[0]?.href === 'string' ? team.logos[0].href : null),
    score: num(competitor?.score),
    // ESPN nests the summary record among several; the overall one is the
    // only one worth a line on a scoreboard.
    record: competitor?.records?.find((r: any) => r?.type === 'total')?.summary
      ?? competitor?.records?.[0]?.summary
      ?? null,
    winner: competitor?.winner === true,
  }
}

/**
 * One league's games for a given day.
 *
 * `date` is ESPN's `YYYYMMDD`. Omitted means today in ESPN's own timezone,
 * which is what their site shows and therefore what a user comparing the
 * two expects.
 */
export async function fetchScoreboard(leagueKey: string, date?: string): Promise<Game[]> {
  const league = leagueFor(leagueKey)
  const groups = league.groups?.length ? league.groups : [null]
  const payloads = await Promise.all(groups.map(async (group) => {
    // The older `site.api` hostname rejects Bun's TLS client at the edge.
    // `site.web.api` serves the same public site payload and is reachable by
    // the production runtime rather than only by browser-shaped clients.
    const url = new URL(`https://site.web.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`)
    if (date)
      url.searchParams.set('dates', date)
    if (group)
      url.searchParams.set('groups', group)
    if (league.limit)
      url.searchParams.set('limit', String(league.limit))

    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        // A scoreboard that has not answered in eight seconds is not a
        // scoreboard worth blocking a page render on.
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok)
        return []
      const payload: any = await res.json()
      return Array.isArray(payload?.events) ? payload.events : []
    }
    catch {
      // Network failure, timeout, or unparseable body. The page renders its
      // empty state; an undocumented upstream going quiet is not an outage
      // worth failing the request over.
      return []
    }
  }))

  // FBS and FCS overlap whenever schools from the two subdivisions play.
  // Keep one copy of a game rather than making one parlay leg appear twice.
  const seen = new Set<string>()
  const events: any[] = payloads.flat().filter((event) => {
    const id = String(event?.id ?? '')
    if (!id || seen.has(id))
      return false
    seen.add(id)
    return true
  })

  return events.flatMap((event) => {
    const competition = event?.competitions?.[0]
    const competitors: any[] = competition?.competitors ?? []
    if (competitors.length < 2)
      return []

    // ESPN does not guarantee ordering, so pick by side rather than index.
    const homeRaw = competitors.find(c => c?.homeAway === 'home') ?? competitors[0]
    const awayRaw = competitors.find(c => c?.homeAway === 'away') ?? competitors[1]
    const status = event?.status ?? competition?.status ?? {}
    const type = status?.type ?? {}

    return [{
      id: String(event?.id ?? ''),
      league: league.key,
      startsAt: String(event?.date ?? ''),
      state: String(type?.state ?? 'pre'),
      status: String(type?.shortDetail ?? type?.description ?? ''),
      // Only meaningful in-play; ESPN leaves stale values on finished games.
      clock: type?.state === 'in' ? String(status?.displayClock ?? '') : '',
      venue: competition?.venue?.fullName ?? null,
      broadcast: competition?.broadcasts?.[0]?.names?.[0] ?? null,
      home: toTeam(homeRaw),
      away: toTeam(awayRaw),
    }]
  })
}

export interface StatPair {
  label: string
  away: string
  home: string
  /** 0-100 share of the pair for the away side, for the comparison bar. */
  awayShare: number
}

export interface GameOdds {
  provider: string
  /** "PHI -162" as the book writes it. */
  details: string
  spread: number | null
  overUnder: number | null
  awayMoneyLine: number | null
  homeMoneyLine: number | null
  /** 'home' | 'away' | null when the book has not called one. */
  favorite: string | null
}

export interface GameDetail {
  id: string
  league: string
  state: string
  status: string
  clock: string
  venue: string | null
  attendance: number | null
  /** Column headings for the line score: innings, quarters, sets. */
  periods: string[]
  home: Team & { line: string[], total: string }
  away: Team & { line: string[], total: string }
  stats: StatPair[]
  odds: GameOdds | null
  note: string | null
}

/**
 * The book's line on a game.
 *
 * ESPN carries several providers; we take the highest-priority one rather
 * than showing a row per book. A page comparing eight sportsbooks is a
 * different product, and the odds board already does that job.
 */
function toOdds(raw: any): GameOdds | null {
  if (!raw)
    return null

  const away = raw?.awayTeamOdds ?? {}
  const home = raw?.homeTeamOdds ?? {}

  return {
    provider: String(raw?.provider?.displayName ?? raw?.provider?.name ?? 'Book'),
    details: String(raw?.details ?? ''),
    spread: num(raw?.spread),
    overUnder: num(raw?.overUnder),
    awayMoneyLine: num(away?.moneyLine),
    homeMoneyLine: num(home?.moneyLine),
    favorite: home?.favorite === true ? 'home' : (away?.favorite === true ? 'away' : null),
  }
}

/**
 * Which team stats are worth a row, per sport.
 *
 * The boxscore returns 59 stats for a baseball team. Almost none of them
 * belong on a summary screen, and a page that prints all of them is a
 * database dump rather than a scoreboard. These are picked by ESPN's
 * `name` field, which is stable across sports in a way the labels are not.
 */
const STAT_PICKS: Record<string, string[]> = {
  mlb: ['hits', 'runs', 'homeRuns', 'RBIs', 'strikeouts', 'walks'],
  nba: ['fieldGoalPct', 'threePointFieldGoalPct', 'freeThrowPct', 'totalRebounds', 'assists', 'turnovers'],
  nfl: ['totalYards', 'netPassingYards', 'rushingYards', 'firstDowns', 'turnovers', 'possessionTime'],
  ncaaf: ['totalYards', 'netPassingYards', 'rushingYards', 'firstDowns', 'turnovers', 'possessionTime'],
  nhl: ['shotsTotal', 'powerPlayGoals', 'faceoffsWon', 'penaltyMinutes', 'hits', 'blockedShots'],
  epl: ['possessionPct', 'totalShots', 'shotsOnTarget', 'foulsCommitted', 'wonCorners', 'saves'],
  atp: ['aces', 'doubleFaults', 'firstServePointsWon', 'breakPoints', 'totalPointsWon', 'winners'],
}

/** Numeric part of a stat, so a percentage and a raw count both compare. */
function statValue(display: string): number {
  const n = Number.parseFloat(String(display).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function flatStats(team: any): Map<string, string> {
  const out = new Map<string, string>()
  for (const group of team?.statistics ?? []) {
    // Flat sports put stats at the top level; baseball nests them a level
    // deeper under batting/pitching/fielding.
    const entries = Array.isArray(group?.stats) && group.stats.length > 0 ? group.stats : [group]
    for (const s of entries) {
      const key = s?.name
      const value = s?.displayValue
      if (typeof key === 'string' && value != null && !out.has(key))
        out.set(key, String(value))
    }
  }
  return out
}

/**
 * One game in full: line score, selected team stats, venue.
 *
 * Same contract as `fetchScoreboard` — it returns null rather than
 * throwing, so the page shows "not found" instead of a 500 when ESPN
 * changes shape or an id is stale.
 */
export async function fetchGame(leagueKey: string, eventId: string): Promise<GameDetail | null> {
  const league = leagueFor(leagueKey)
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/${league.path}/summary?event=${encodeURIComponent(eventId)}`

  let d: any
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok)
      return null
    d = await res.json()
  }
  catch {
    return null
  }

  const competition = d?.header?.competitions?.[0]
  const competitors: any[] = competition?.competitors ?? []
  if (competitors.length < 2)
    return null

  const homeRaw = competitors.find(c => c?.homeAway === 'home') ?? competitors[0]
  const awayRaw = competitors.find(c => c?.homeAway === 'away') ?? competitors[1]
  const type = competition?.status?.type ?? {}

  const line = (c: any): string[] => (c?.linescores ?? []).map((l: any) => String(l?.displayValue ?? '-'))
  const homeLine = line(homeRaw)
  const awayLine = line(awayRaw)
  const periodCount = Math.max(homeLine.length, awayLine.length)

  // Box teams are ordered independently of the header, so match by id
  // rather than trusting the index.
  const boxTeams: any[] = d?.boxscore?.teams ?? []
  const boxFor = (c: any) => boxTeams.find(b => String(b?.team?.id ?? '') === String(c?.team?.id ?? '')) ?? null
  const homeStats = flatStats(boxFor(homeRaw))
  const awayStats = flatStats(boxFor(awayRaw))

  const picks = STAT_PICKS[league.key] ?? []
  const stats: StatPair[] = picks.flatMap((key) => {
    const a = awayStats.get(key)
    const h = homeStats.get(key)
    if (a == null || h == null)
      return []

    const av = statValue(a)
    const hv = statValue(h)
    const total = av + hv
    const labelSource = boxFor(awayRaw)?.statistics?.flatMap((g: any) => g?.stats ?? [g])
      ?.find((s: any) => s?.name === key)

    return [{
      label: String(labelSource?.displayName ?? labelSource?.shortDisplayName ?? key),
      away: a,
      home: h,
      // A 0-0 pair splits evenly rather than dividing by zero.
      awayShare: total > 0 ? Math.round((av / total) * 100) : 50,
    }]
  })

  const toDetailTeam = (raw: any, l: string[]): Team & { line: string[], total: string } => ({
    ...toTeam(raw),
    line: l,
    total: String(raw?.score ?? ''),
  })

  return {
    id: String(eventId),
    league: league.key,
    state: String(type?.state ?? 'pre'),
    status: String(type?.shortDetail ?? type?.description ?? ''),
    clock: type?.state === 'in' ? String(competition?.status?.displayClock ?? '') : '',
    venue: d?.gameInfo?.venue?.fullName ?? null,
    attendance: num(d?.gameInfo?.attendance),
    periods: Array.from({ length: periodCount }, (_, i) => String(i + 1)),
    home: toDetailTeam(homeRaw, homeLine),
    away: toDetailTeam(awayRaw, awayLine),
    stats,
    // pickcenter is the richer of the two and carries the moneylines;
    // `odds` on the competition is the fallback when it is absent.
    odds: toOdds((d?.pickcenter ?? [])[0] ?? (competition?.odds ?? [])[0]),
    note: d?.header?.competitions?.[0]?.notes?.[0]?.headline ?? null,
  }
}
