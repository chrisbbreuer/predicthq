import type { Database } from '../../Support/db'
import { injurySeverity } from './severity'

export interface ReportedInjury {
  athleteId: string
  name: string
  position: string
  status: string
  type: string
  detail: string
  side: string
  returnDate: string
  updatedAt: string
  comment: string
  severity: number
}

export function reportedInjury(item: any): ReportedInjury | null {
  const athlete = item?.athlete
  const name = String(athlete?.displayName ?? '').trim()
  if (!name)
    return null
  const link = (athlete?.links ?? []).find((l: any) => String(l.href ?? '').includes('/player/'))?.href ?? ''
  return {
    athleteId: String(athlete?.id ?? String(link).match(/\/id\/(\d+)/)?.[1] ?? ''), name,
    position: String(athlete?.position?.abbreviation ?? ''), status: String(item.status ?? ''),
    type: String(item.details?.type ?? ''), detail: String(item.details?.detail ?? ''), side: String(item.details?.side ?? ''),
    returnDate: String(item.details?.returnDate ?? ''), updatedAt: String(item.date ?? ''),
    comment: String(item.longComment ?? item.shortComment ?? ''), severity: injurySeverity(item.status),
  }
}

/** Called only for a validated, successful league-wide response and its complete team roster. */
export async function saveInjuryReports(db: Database, teams: Array<{ id: number, espnId: string }>, blocks: any[], capturedAt: string): Promise<number> {
  if (blocks.some(block => !String(block?.id ?? block?.team?.id ?? '') || !Array.isArray(block?.injuries) || block.injuries.some((item: any) => !reportedInjury(item))))
    throw new Error('Malformed team injury report; previous capture retained')
  let count = 0
  await db.transaction(async (tx) => {
    for (const team of teams) {
      const block = blocks.find(b => String(b.id ?? b.team?.id ?? '') === team.espnId)
      const injuries = (block?.injuries ?? []).map(reportedInjury).filter((i: ReportedInjury | null): i is ReportedInjury => i !== null)
      await tx.prepare(`INSERT INTO team_injury_reports (sports_team_id, injuries, source, captured_at, created_at, updated_at) VALUES (?, ?, 'espn', ?, ?, ?)`)
        .run(team.id, JSON.stringify(injuries), capturedAt, capturedAt, capturedAt)
      count += injuries.length
    }
  })
  return count
}

export async function injuryReport(db: Database, teamId: number, now = Date.now()): Promise<{ known: boolean, capturedAt: string | null, source: string, injuries: ReportedInjury[] }> {
  const row = await db.query<{ injuries: string, captured_at: string, source: string }>(`SELECT injuries, captured_at, source FROM team_injury_reports WHERE sports_team_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`).get(teamId)
  if (!row)
    return { known: false, capturedAt: null, source: 'espn', injuries: [] }
  const age = now - Date.parse(row.captured_at)
  return { known: Number.isFinite(age) && age >= 0 && age < 6 * 3_600_000, capturedAt: row.captured_at, source: row.source, injuries: JSON.parse(row.injuries) }
}
