import type { Database } from '../../Support/db'
import type { ReportedInjury } from '../fundamentals/injuries'
import type { FinalBox } from './box-history'
import type { Fixture, InjurySnapshot, PlayedGame } from './score-model'
import { utcTime } from '../trading/winner-context'
import { scoreLeagues } from './box-history'
import { replayScores } from './score-model'

const day = 86_400_000
const minutes = 60_000

interface HistoryRow {
  id: number
  commence_at: string
  home_sports_team_id: number
  away_sports_team_id: number
  home_score: number
  away_score: number
  settled_at: string
  source: string
}

interface InjuryRow { sports_team_id: number, injuries: string, captured_at: string }
interface BoxRow { market_event_id: number, payload: string, captured_at: string }

async function scoreHistory(db: Database, league: string, from: number, until: number, includeBoxes = true): Promise<PlayedGame[]> {
  const rows = await db.query<HistoryRow>(`
    SELECT e.id, e.commence_at, e.home_sports_team_id, e.away_sports_team_id,
      r.home_score, r.away_score, r.settled_at, r.source
    FROM market_events e JOIN sports s ON s.id = e.sport_id
    JOIN event_results r ON r.market_event_id = e.id
    WHERE s.slug = ? AND r.completed = 1 AND e.commence_at BETWEEN ? AND ?
      AND e.home_sports_team_id IS NOT NULL AND e.away_sports_team_id IS NOT NULL
  `).all(league, new Date(from).toISOString(), new Date(until).toISOString())
  const boxes = new Map<number, BoxRow>()
  if (includeBoxes) {
    for (let i = 0; i < rows.length; i += 24) {
      const batch = rows.slice(i, i + 24)
      const stored = await db.query<BoxRow>(`
        SELECT market_event_id, payload, captured_at FROM game_box_scores
        WHERE market_event_id IN (${batch.map(() => '?').join(',')}) AND payload <> ''
      `).all(...batch.map(row => row.id))
      for (const box of stored)
        boxes.set(Number(box.market_event_id), box)
    }
  }
  return rows.flatMap((row): PlayedGame[] => {
    const starts = utcTime(row.commence_at)
    if (row.home_score == null || row.away_score == null || !Number.isFinite(starts))
      return []
    const final = [Number(row.home_score), Number(row.away_score)] as [number, number]
    const archived = boxes.get(Number(row.id))
    const box = archived ? JSON.parse(archived.payload) as FinalBox : undefined
    const observed = utcTime(row.settled_at)
    // Archived scoreboards lack receipt timestamps. In replays, allow the
    // verified outcome only a full day later, excluding same-day results.
    const knownAt = row.source === 'espn_archive' ? starts + day : observed
    if (knownAt <= starts || !Number.isFinite(knownAt) || final.some(score => !Number.isInteger(score) || score < 0))
      return []
    return [{ id: Number(row.id), starts, home: Number(row.home_sports_team_id), away: Number(row.away_sports_team_id), final,
      knownAt, box, boxKnownAt: archived ? utcTime(archived.captured_at) : undefined, neutral: box?.neutralSite }]
  })
}

async function injuryHistory(db: Database, fixtures: Fixture[], asOf = Infinity) {
  const oldest = fixtures.length > 1 ? await db.query<{ at: string | null }>('SELECT MIN(captured_at) AS at FROM team_injury_reports').get() : null
  const first = oldest?.at ? utcTime(oldest.at) : -Infinity
  const requests = fixtures.flatMap((game) => {
    const at = Math.min(asOf, game.starts - 30 * minutes)
    return at < first ? [] : [{ id: game.home, at }, { id: game.away, at }]
  })
  const latest = db.query<InjuryRow>(`
    SELECT sports_team_id, injuries, captured_at FROM team_injury_reports
    WHERE sports_team_id = ? AND captured_at BETWEEN ? AND ?
    ORDER BY captured_at DESC, id DESC LIMIT 1
  `)
  const byTeam = new Map<number, InjurySnapshot[]>()
  for (let i = 0; i < requests.length; i += 12) {
    const rows = await Promise.all(requests.slice(i, i + 12).map(request => latest.get(request.id,
      new Date(request.at - 6 * 3_600_000).toISOString(), new Date(request.at).toISOString())))
    for (const row of rows) {
      if (!row)
        continue
      const id = Number(row.sports_team_id)
      const at = utcTime(row.captured_at)
      const samples = byTeam.get(id) ?? []
      if (samples.every(sample => sample.at !== at))
        samples.push({ at, injuries: JSON.parse(row.injuries) as ReportedInjury[] })
      byTeam.set(id, samples)
    }
  }
  for (const samples of byTeam.values())
    samples.sort((a, b) => b.at - a.at)
  return byTeam
}

export async function backtestScoreForecasts(db: Database, leagues: string[], days: number, now = Date.now(), includeBoxes = true) {
  const since = now - days * day
  const results = []
  for (const league of leagues) {
    if (!scoreLeagues.includes(league))
      continue
    const history = await scoreHistory(db, league, since - 120 * day, now, includeBoxes)
    const injuries = await injuryHistory(db, history)
    const report = replayScores(league, history, injuries, [], since)
    results.push({ league, finals: history.filter(game => game.starts >= since).length, potentialBoxHistory: history.filter(game => game.box).length,
      teamsWithInjurySnapshots: injuries.size, metrics: report.metrics, featureTraining: report.featureTraining })
  }
  return { cutoffMinutes: 30, archivedScoreDelayHours: 24, days, leagues: results }
}

export async function projectScore(db: Database, league: string, fixture: Fixture, now = Date.now()) {
  if (!scoreLeagues.includes(league) || !Number.isFinite(fixture.starts) || fixture.starts <= now)
    return null
  const [history, injuries] = await Promise.all([
    scoreHistory(db, league, now - 120 * day, now, false),
    injuryHistory(db, [fixture], now),
  ])
  const projection = replayScores(league, history, injuries, [fixture]).fixtures.get(fixture.id)
  const predicted = projection?.scores.opponentAdjusted
  if (!projection || !predicted)
    return null
  const [home, away] = predicted.map(score => Math.round(score * 10) / 10) as [number, number]
  const round = (score: number) => Math.round(score * 10) / 10
  return { home, away, total: round(home + away), margin: round(home - away), inputs: projection.inputs }
}
