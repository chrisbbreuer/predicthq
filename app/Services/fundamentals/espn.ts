import { saveInjuryReports } from './injuries'
import type { Database } from '../../Support/db'
import { loadSports, resolveTeam } from '../ingest/resolve'
import { fetchWithRetry, IngestRunTracker } from '../ingest/run'
import { injurySeverity } from './severity'

/**
 * Team fundamentals from ESPN: how each side is doing, and who is out.
 *
 * These endpoints were always available and were never read. The schedule
 * ingest already calls this host and keeps fixtures and scores, and it
 * writes a `record` column that nothing downstream has ever looked at.
 * Everything that prices a market does so from bookmaker quotes alone, so
 * the model has had no way to hold an opinion the books do not already
 * hold.
 *
 * Both passes are additive: a row per team per capture, never an update.
 * A prediction has to stay scoreable against what was knowable when it
 * was made, and an updating row silently rewrites that history.
 */

// `site.api.espn.com` answers Bun's TLS client with 403 from the production
// host; `site.web.api` serves the same public payloads. See scores/espn.ts.
const STANDINGS = 'https://site.web.api.espn.com/apis/v2/sports'
const SCOREBOARD = 'https://site.web.api.espn.com/apis/site/v2/sports'

function nowIso(): string {
  return new Date().toISOString()
}

export interface FundamentalsResult {
  provider: string
  status: string
  standingsWritten: number
  injuriesWritten: number
  leagues: number
  unmatched: number
  errors: string[]
}

/** Pull a named stat off ESPN's `stats` array, which is a list not a map. */
function stat(entry: any, name: string): number {
  const found = (entry?.stats ?? []).find((s: any) => s?.name === name)
  const value = Number(found?.value ?? Number.NaN)
  return Number.isFinite(value) ? value : 0
}

/**
 * ESPN nests standings groups arbitrarily deep (league → conference →
 * division), and the depth differs per sport. Flatten to the groups that
 * actually carry entries rather than assuming a shape per sport.
 */
function collectGroups(node: any, out: Array<{ name: string, entries: any[] }> = []): Array<{ name: string, entries: any[] }> {
  if (!node || typeof node !== 'object')
    return out

  const entries = node?.standings?.entries
  if (Array.isArray(entries) && entries.length)
    out.push({ name: String(node.name ?? node.displayName ?? ''), entries })

  for (const child of node.children ?? [])
    collectGroups(child, out)

  return out
}

export async function ingestEspnFundamentals(db: Database): Promise<FundamentalsResult> {
  const tracker = new IngestRunTracker(db, 'espn', 'fundamentals')
  await tracker.start()

  const sports = (await loadSports(db)).filter(s => s.espn_path && !s.non_sporting)
  const capturedAt = nowIso()

  let standingsWritten = 0
  let injuriesWritten = 0
  let leagues = 0

  for (const sport of sports) {
    let touched = false

    // --- roster ----------------------------------------------------------
    // Make sure every competitor has a row before anything tries to match
    // a fixture to one. Standings alone are not enough: a friendly is not
    // a league and has no table, so the 183 nations that play them would
    // exist only where a qualifying group happened to mention them, and a
    // fixture between two of the rest would silently fail to resolve.
    const teamsRes = await fetchWithRetry(`${SCOREBOARD}/${sport.espn_path}/teams`)
    tracker.requestCount++

    const reportTeams: Array<{ id: number, espnId: string }> = []
    if (teamsRes?.ok) {
      try {
        const payload = await teamsRes.json() as any
        const entries = payload?.sports?.[0]?.leagues?.[0]?.teams ?? []

        for (const entry of entries) {
          const team = entry?.team
          const name = String(team?.displayName ?? '').trim()
          if (!name)
            continue

          // resolveTeam creates on a miss, which is what is wanted here:
          // this feed is the authority on who competes in its league.
          const teamId = await resolveTeam(db, sport.id, name, {
            espnId: String(team?.id ?? ''),
            abbreviation: String(team?.abbreviation ?? ''),
            shortName: String(team?.shortDisplayName ?? ''),
            logo: String(team?.logos?.[0]?.href ?? ''),
          })
          if (teamId && team?.id) reportTeams.push({ id: teamId, espnId: String(team.id) })
          touched = true
        }
      }
      catch (err) {
        tracker.fail(`${sport.slug}: teams ${(err as Error).message}`)
      }
    }

    // --- standings -------------------------------------------------------
    const standingsRes = await fetchWithRetry(`${STANDINGS}/${sport.espn_path}/standings`)
    tracker.requestCount++

    if (!standingsRes?.ok) {
      tracker.fail(`${sport.slug}: standings unreachable`)
    }
    else {
      try {
        const groups = collectGroups(await standingsRes.json())
        await db.transaction(async (transaction) => {
          for (const group of groups) {
            for (const entry of group.entries) {
              tracker.rowsRead++
              const name = String(entry?.team?.displayName ?? '').trim()
              const teamId = name
                ? await resolveTeam(transaction, sport.id, name, { espnId: String(entry?.team?.id ?? '') })
                : null

              if (!teamId) {
                tracker.unmatchedCount++
                continue
              }

              const wins = stat(entry, 'wins')
              const losses = stat(entry, 'losses')
              const ties = stat(entry, 'ties')
              const played = stat(entry, 'gamesPlayed') || (wins + losses + ties)
              // A draw counts as half a win, the standard convention, so
              // sports that draw and sports that cannot are comparable.
              const percent = played > 0 ? (wins + ties / 2) / played : 0

              await transaction.prepare(`
                INSERT INTO team_standings
                  (sports_team_id, wins, losses, ties, games_played, win_percent, points_for,
                  points_against, point_differential, playoff_seed, group_name, source, captured_at,
                  created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'espn', ?, ?, ?)
              `).run(
                teamId,
                wins,
                losses,
                ties,
                played,
                Math.min(1, Math.max(0, percent)),
                stat(entry, 'pointsFor'),
                stat(entry, 'pointsAgainst'),
                stat(entry, 'pointDifferential') || stat(entry, 'differential'),
                stat(entry, 'playoffSeed'),
                group.name.slice(0, 80),
                capturedAt,
                capturedAt,
                capturedAt,
              )
              standingsWritten++
              tracker.rowsWritten++
              touched = true
            }
          }
        })
      }
      catch (err) {
        tracker.fail(`${sport.slug}: standings ${(err as Error).message}`)
      }
    }

    // --- injuries --------------------------------------------------------
    const injuriesRes = await fetchWithRetry(`${SCOREBOARD}/${sport.espn_path}/injuries`)
    tracker.requestCount++

    if (injuriesRes?.ok) {
      try {
        const payload = await injuriesRes.json() as any
        if (!Array.isArray(payload?.injuries))
          throw new Error('Invalid injury report; keeping previous capture')
        if (reportTeams.length > 0)
          await saveInjuryReports(db, reportTeams, payload.injuries, capturedAt)
        await db.transaction(async (transaction) => {
          for (const teamBlock of payload?.injuries ?? []) {
            const name = String(teamBlock?.displayName ?? '').trim()
            const teamId = name ? await resolveTeam(transaction, sport.id, name) : null

            if (!teamId) {
              if (name)
                tracker.unmatchedCount++
              continue
            }

            for (const item of teamBlock?.injuries ?? []) {
              tracker.rowsRead++
              const athlete = String(item?.athlete?.displayName ?? '').trim()
              if (!athlete)
                continue

              const status = String(item?.status ?? '')
              await transaction.prepare(`
                INSERT INTO team_injuries
                  (sports_team_id, athlete_name, status, injury_type, severity, source, captured_at,
                  created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'espn', ?, ?, ?)
              `).run(
                teamId,
                athlete.slice(0, 120),
                status.slice(0, 60),
                String(item?.details?.type ?? '').slice(0, 80),
                injurySeverity(status),
                capturedAt,
                capturedAt,
                capturedAt,
              )
              injuriesWritten++
              tracker.rowsWritten++
              touched = true
            }
          }
        })
      }
      catch (err) {
        tracker.fail(`${sport.slug}: injuries ${(err as Error).message}`)
      }
    }

    else {
      tracker.fail(`${sport.slug}: injuries ${injuriesRes ? `HTTP ${injuriesRes.status}` : 'unreachable'}`)
    }

    if (touched)
      leagues++
  }

  const { status, errors } = await tracker.finish(
    `${leagues} leagues · ${standingsWritten} standings · ${injuriesWritten} injuries`,
  )

  return {
    provider: 'espn',
    status,
    standingsWritten,
    injuriesWritten,
    leagues,
    unmatched: tracker.unmatchedCount,
    errors,
  }
}
