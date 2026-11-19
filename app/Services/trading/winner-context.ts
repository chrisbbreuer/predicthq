import type { Database } from '../../Support/db'

export interface TeamGame {
  at: number
  scored: number
  allowed: number
}

export type WinnerContext = [form: number, margin: number, rest: number, congestion: number]

const marginScale: Record<string, number> = { nba: 15, wnba: 15, nhl: 2, nfl: 14, ncaaf: 18, ncaab: 17, ncaaw: 17, mlb: 4 }

export function utcTime(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value)
}

/** Winner context signed toward the market's YES team. All results must already be known. */
export function winnerContext(mine: TeamGame[], theirs: TeamGame[], league: string, start: number): WinnerContext | null {
  if (mine.length < 3 || theirs.length < 3)
    return null
  const recent = (games: TeamGame[]) => games.slice(0, 8)
  const form = (games: TeamGame[]) => recent(games).reduce((sum, g) => sum + Math.sign(g.scored - g.allowed), 0) / (recent(games).length + 4)
  const margin = (games: TeamGame[]) => recent(games).reduce((sum, g) => sum + Math.tanh((g.scored - g.allowed) / (marginScale[league] ?? 10)), 0) / (recent(games).length + 4)
  const rest = (games: TeamGame[]) => Math.min(4, (start - games[0]!.at) / 86_400_000)
  const count = (games: TeamGame[]) => games.filter(g => start - g.at < 7 * 86_400_000).length
  return [form(mine) - form(theirs), margin(mine) - margin(theirs), (rest(mine) - rest(theirs)) / 4, (count(theirs) - count(mine)) / 7]
}

export async function captureWinnerContext(db: Database, eventId: number, league: string, start: number, at: number): Promise<WinnerContext | null> {
  const event = await db.query<{ home_sports_team_id: number, away_sports_team_id: number }>('SELECT home_sports_team_id, away_sports_team_id FROM market_events WHERE id = ?').get(eventId)
  if (!event?.home_sports_team_id || !event.away_sports_team_id)
    return null
  const gamesFor = async (teamId: number) => {
    const rows = await db.query<{ commence_at: string, home_sports_team_id: number, home_score: number, away_score: number }>(`
      SELECT e.commence_at, e.home_sports_team_id, r.home_score, r.away_score
      FROM market_events e JOIN event_results r ON r.market_event_id = e.id
      WHERE (e.home_sports_team_id = ? OR e.away_sports_team_id = ?)
        AND e.id <> ? AND r.completed = 1 AND e.commence_at < ?
        AND r.settled_at <> '' AND r.settled_at <= ?
      ORDER BY e.commence_at DESC LIMIT 20
    `).all(teamId, teamId, eventId, new Date(at).toISOString(), new Date(at).toISOString())
    return rows.map(row => {
      const home = Number(row.home_sports_team_id) === Number(teamId)
      return { at: utcTime(row.commence_at), scored: Number(home ? row.home_score : row.away_score), allowed: Number(home ? row.away_score : row.home_score) }
    }).filter(row => Number.isFinite(row.at))
  }
  const [home, away] = await Promise.all([gamesFor(event.home_sports_team_id), gamesFor(event.away_sports_team_id)])
  return winnerContext(home, away, league, start)
}
