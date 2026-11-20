import { kalshiScoreboard } from '../scores/kalshi'
import type { Database } from '../../Support/db'
import type { SportRow } from './resolve'
import { nowIso, toIso } from '../../Support/keys'
import { loadSports, resolveEvent, resolveExistingTeam, resolveTeam } from './resolve'
import { fetchWithRetry, IngestRunTracker } from './run'

/**
 * ESPN as the schedule-and-results backbone.
 *
 * ESPN's site API needs no key or account and supplies two things the
 * system cannot function without. Access is not guaranteed; Kalshi's
 * milestone and live-data feeds provide a fallback where listed:
 * **which games exist** and **how they finished**. Odds feeds are metered
 * and partial; a schedule is neither, and every paid request we spend
 * discovering fixtures is one not spent on prices.
 *
 * It is also what closes the loop that was previously open. Scores were
 * already fetched here for display and then discarded, so nothing was ever
 * graded and no claim about accuracy could be checked. Persisting results
 * is what turns the feature snapshots into a labelled training set instead
 * of a log.
 *
 * The API is undocumented and unstable by nature, so every read is
 * defensive: a shape change degrades to fewer events rather than a thrown
 * pass, and the run row records how many were skipped.
 */

// `site.api.espn.com` answers Bun's TLS client with 403 from the production
// host; `site.web.api` serves the same public payloads. See scores/espn.ts.
const SCOREBOARD = 'https://site.web.api.espn.com/apis/site/v2/sports'

interface EspnCompetitor {
  homeAway?: string
  score?: unknown
  winner?: boolean
  records?: Array<{ type?: string, summary?: string }>
  team?: {
    id?: string
    displayName?: string
    name?: string
    shortDisplayName?: string
    abbreviation?: string
    logo?: string
    logos?: Array<{ href?: string }>
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Map ESPN's state vocabulary onto ours.
 *
 * ESPN uses 'pre' | 'in' | 'post', but 'post' covers postponed and
 * cancelled games as well as finished ones — settling those as finals
 * would grade markets that should have been voided, so the detail text is
 * checked before a game is called final.
 */
function mapStatus(state: string, detail: string): string {
  const d = detail.toLowerCase()
  if (d.includes('postponed'))
    return 'postponed'
  if (d.includes('canceled') || d.includes('cancelled'))
    return 'cancelled'
  if (state === 'in')
    return 'live'
  if (state === 'post')
    return 'final'
  return 'scheduled'
}

/** ESPN's `YYYYMMDD` for a day offset from today. */
function espnDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface EspnIngestResult {
  provider: string
  status: string
  eventsSeen: number
  eventsCreated: number
  resultsWritten: number
  leagues: number
  errors: string[]
}

export async function importEspnFinals(db: Database, entries: Array<{ league: string, events: unknown[] }>) {
  const sports = new Map((await loadSports(db)).filter(sport => sport.espn_path && !sport.non_sporting).map(sport => [sport.slug, sport]))
  const results: Record<string, number> = {}
  for (const entry of entries) {
    const sport = sports.get(entry.league)
    if (!sport || !Array.isArray(entry.events))
      continue
    for (const raw of entry.events) {
      const event = raw as { date?: string, status?: { type?: { completed?: boolean } } } | null
      const starts = Date.parse(event?.date ?? '')
      if (event?.status?.type?.completed !== true || !Number.isFinite(starts) || starts > Date.now() - 86_400_000)
        continue
      const stored = await ingestOneEvent(db, sport, event, 'espn', true)
      if (stored?.resultWritten)
        results[sport.slug] = (results[sport.slug] ?? 0) + 1
    }
  }
  return results
}

/**
 * Pull the schedule and results for every active, sporting league.
 *
 * `daysAhead`/`daysBack` bound the sweep. Looking back matters as much as
 * forward: a game that finished after the last pass needs its result
 * recorded, and a single-day window would miss anything that ran late or
 * happened while the worker was down.
 */
export async function ingestEspn(
  db: Database,
  options: { daysAhead?: number, daysBack?: number } = {},
): Promise<EspnIngestResult> {
  const daysAhead = options.daysAhead ?? 3
  const daysBack = options.daysBack ?? 1

  const tracker = new IngestRunTracker(db, 'espn', 'schedule')
  await tracker.start()

  const sports = (await loadSports(db)).filter(s => s.espn_path && !s.non_sporting)

  let eventsSeen = 0
  let eventsCreated = 0
  let resultsWritten = 0

  for (const sport of sports) {
    for (let offset = -daysBack; offset <= daysAhead; offset++) {
      const url = `${SCOREBOARD}/${sport.espn_path}/scoreboard?dates=${espnDate(offset)}&limit=200`
      tracker.requestCount++

      const res = await fetchWithRetry(url, { timeoutMs: 10_000 })
      if (!res || !res.ok) {
        tracker.fail(`${sport.slug} ${offset >= 0 ? '+' : ''}${offset}d: ${res ? `HTTP ${res.status}` : 'network'}; using Kalshi where available`)
        const games = await kalshiScoreboard(sport.slug, espnDate(offset)).catch(() => [])
        for (const game of games) {
          const outcome = await ingestOneEvent(db, sport, {
            id: game.eventTicker, date: game.startsAt,
            status: { type: { state: game.state, shortDetail: game.status } },
            competitions: [{ competitors: (['home', 'away'] as const).map(side => ({
              homeAway: side, score: game[side].score, team: { displayName: game[side].name },
            })) }],
          }, 'kalshi')
          tracker.rowsRead++
          if (outcome) {
            eventsSeen++
            tracker.rowsWritten++
            if (outcome.created) eventsCreated++
            if (outcome.resultWritten) resultsWritten++
          }
        }
        continue
      }

      let payload: any
      try {
        payload = await res.json()
      }
      catch {
        tracker.fail(`${sport.slug}: unparseable body`)
        continue
      }

      const events: any[] = Array.isArray(payload?.events) ? payload.events : []
      tracker.rowsRead += events.length

      for (const event of events) {
        const outcome = await ingestOneEvent(db, sport, event)
        if (outcome === null) {
          tracker.unmatchedCount++
          continue
        }
        eventsSeen++
        tracker.rowsWritten++
        if (outcome.created)
          eventsCreated++
        if (outcome.resultWritten)
          resultsWritten++
      }
    }
  }

  const summary = `${sports.length} leagues · ${eventsSeen} events (${eventsCreated} new) · ${resultsWritten} results`
  const { status, errors } = await tracker.finish(summary)

  return {
    provider: 'espn',
    status,
    eventsSeen,
    eventsCreated,
    resultsWritten,
    leagues: sports.length,
    errors,
  }
}

/**
 * Persist one scoreboard entry: teams, event, and — when it has finished —
 * the result.
 *
 * Returns null for anything unusable rather than throwing, so one odd row
 * cannot cost the rest of the league.
 */
async function ingestOneEvent(
  db: Database,
  sport: SportRow,
  event: any,
  provider = 'espn',
  archive = false,
): Promise<{ created: boolean, resultWritten: boolean } | null> {
  const externalId = String(event?.id ?? '')
  if (!externalId)
    return null

  const competition = event?.competitions?.[0]
  const competitors: EspnCompetitor[] = competition?.competitors ?? []
  if (competitors.length < 2)
    return null

  // ESPN does not guarantee ordering, so pick by side rather than index.
  const homeRaw = competitors.find(c => c?.homeAway === 'home') ?? competitors[0]
  const awayRaw = competitors.find(c => c?.homeAway === 'away') ?? competitors[1]
  if (!homeRaw || !awayRaw)
    return null

  let homeName = String(homeRaw.team?.displayName ?? homeRaw.team?.name ?? '')
  let awayName = String(awayRaw.team?.displayName ?? awayRaw.team?.name ?? '')
  if (!homeName || !awayName)
    return null

  if (provider === 'kalshi') {
    const canonicalName = async (name: string) => {
      const suffix = /^[A-Z]{2,4} (.{4,})$/.exec(name)?.[1]
      const id = await resolveExistingTeam(db, sport.id, name) ?? (suffix ? await resolveExistingTeam(db, sport.id, suffix) : null)
      if (!id) return null
      return (await db.query<{ name: string }>('SELECT name FROM sports_teams WHERE id = ?').get(id))?.name ?? null
    }
    const home = await canonicalName(homeName)
    const away = await canonicalName(awayName)
    if (!home || !away || home === away) return null
    homeName = home
    awayName = away
  }

  const homeTeamId = await resolveTeam(db, sport.id, homeName, {
    shortName: homeRaw.team?.shortDisplayName,
    abbreviation: homeRaw.team?.abbreviation,
    logo: homeRaw.team?.logo ?? homeRaw.team?.logos?.[0]?.href,
    espnId: homeRaw.team?.id,
    record: archive ? undefined : homeRaw.records?.find(r => r?.type === 'total')?.summary ?? homeRaw.records?.[0]?.summary,
  })
  const awayTeamId = await resolveTeam(db, sport.id, awayName, {
    shortName: awayRaw.team?.shortDisplayName,
    abbreviation: awayRaw.team?.abbreviation,
    logo: awayRaw.team?.logo ?? awayRaw.team?.logos?.[0]?.href,
    espnId: awayRaw.team?.id,
    record: archive ? undefined : awayRaw.records?.find(r => r?.type === 'total')?.summary ?? awayRaw.records?.[0]?.summary,
  })

  const commenceAt = toIso(event?.date)
  if (!commenceAt)
    return null

  const statusBlock = event?.status ?? competition?.status ?? {}
  const type = statusBlock?.type ?? {}
  const detail = String(type?.shortDetail ?? type?.description ?? '')
  const status = mapStatus(String(type?.state ?? 'pre'), detail)

  const { eventId, created } = await resolveEvent(db, {
    sportId: sport.id,
    provider,
    externalId,
    // ESPN orders its own titles away-at-home; ours reads the same way so
    // the board and the scoreboard agree at a glance.
    title: `${awayName} at ${homeName}`,
    commenceAt,
    homeTeamId,
    awayTeamId,
    category: sport.grouping,
    league: sport.title,
    venue: competition?.venue?.fullName ?? '',
    broadcast: competition?.broadcasts?.[0]?.names?.[0] ?? '',
  })

  await db.prepare('UPDATE market_events SET status = ?, status_detail = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'live' ? String(statusBlock?.displayClock ?? detail) : detail, nowIso(), nowIso(), eventId)

  let resultWritten = false
  if (status === 'final') {
    const homeScore = num(homeRaw.score)
    const awayScore = num(awayRaw.score)
    if (homeScore !== null && awayScore !== null) {
      resultWritten = await writeResult(db, eventId, homeScore, awayScore, competition, archive ? 'espn_archive' : provider)
    }
  }

  return { created, resultWritten }
}

/**
 * Record the final score.
 *
 * Upserts rather than inserts because a game can be re-reported — ESPN
 * corrects scores, and a stat correction hours later should update the
 * grade rather than fail on a duplicate key.
 *
 * `graded_at` is deliberately left empty: writing the result and grading
 * the markets against it are separate passes, so a correction here
 * re-opens grading automatically.
 */
async function writeResult(
  db: Database,
  eventId: number,
  homeScore: number,
  awayScore: number,
  competition: any,
  provider: string,
): Promise<boolean> {
  const winnerSide = homeScore > awayScore ? 'home' : (awayScore > homeScore ? 'away' : 'draw')

  const periodScores = JSON.stringify({
    home: (competition?.competitors ?? []).find((c: any) => c?.homeAway === 'home')?.linescores?.map((l: any) => num(l?.value) ?? 0) ?? [],
    away: (competition?.competitors ?? []).find((c: any) => c?.homeAway === 'away')?.linescores?.map((l: any) => num(l?.value) ?? 0) ?? [],
  })

  const previous = await db.query<{ home_score: number, away_score: number, graded_at: string, settled_at: string }>(
    'SELECT home_score, away_score, graded_at, settled_at FROM event_results WHERE market_event_id = ?',
  ).get(eventId)
  if (provider === 'espn_archive' && previous)
    return false
  const unchanged = previous && Number(previous.home_score) === homeScore && Number(previous.away_score) === awayScore
  const at = nowIso()
  await db.updateOrInsert('event_results', { market_event_id: eventId }, {
    home_score: homeScore,
    away_score: awayScore,
    winner_side: winnerSide,
    period_scores: periodScores,
    completed: 1,
    source: provider,
    settled_at: unchanged ? previous.settled_at : at,
    graded_at: unchanged ? previous.graded_at : '',
    updated_at: at,
  })
  return true
}
