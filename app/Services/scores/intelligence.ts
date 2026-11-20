import type { Database } from '../../Support/db'
import type { GameDetail } from './espn'
import { injuryReport } from '../fundamentals/injuries'
import { loadScheduleContext } from '../quant/schedule'
import { utcTime } from '../trading/winner-context'
import { projectScore } from './score-forecast'

/** Facts from settled results only; the game being viewed never enters its own form. */
export async function teamIntelligence(db: Database, teamId: number, startsAt: string, venue: string | null, now = Date.now()) {
  const [schedule, injuries, recent] = await Promise.all([
    loadScheduleContext(db, teamId, startsAt), injuryReport(db, teamId, now),
    db.query<{ commence_at: string, venue: string, home_sports_team_id: number, home_score: number, away_score: number }>(`
      SELECT e.commence_at, e.venue, e.home_sports_team_id, r.home_score, r.away_score
      FROM market_events e JOIN event_results r ON r.market_event_id = e.id
      WHERE (e.home_sports_team_id = ? OR e.away_sports_team_id = ?)
        AND e.commence_at < ? AND e.status = 'final' AND r.completed = 1
      ORDER BY e.commence_at DESC LIMIT 10
    `).all(teamId, teamId, startsAt),
  ])
  const form = recent.map(row => {
    const home = Number(row.home_sports_team_id) === teamId
    const scored = Number(home ? row.home_score : row.away_score)
    const conceded = Number(home ? row.away_score : row.home_score)
    return { date: row.commence_at, scored, conceded, result: scored > conceded ? 'W' : scored < conceded ? 'L' : 'D' }
  })
  let streak = 0
  for (const row of form) {
    if (row.result !== form[0]?.result)
      break
    streak++
  }
  const previousVenue = recent[0]?.venue?.trim() || null
  const currentVenue = venue?.trim() || null
  return {
    ...schedule, injuries, form,
    wins: form.filter(row => row.result === 'W').length,
    losses: form.filter(row => row.result === 'L').length,
    streak: streak ? `${form[0]!.result}${streak}${streak === 10 ? '+' : ''}` : null,
    // A venue change is evidence of travel between fixtures, not a flight itinerary.
    travel: { venueChanged: previousVenue && currentVenue ? previousVenue.toLowerCase() !== currentVenue.toLowerCase() : null, previousVenue, currentVenue },
  }
}

export async function gameIntelligence(db: Database, game: GameDetail) {
  const event = await db.query<{ id: number, home_sports_team_id: number, away_sports_team_id: number, commence_at: string, venue: string }>(`
    SELECT e.id, e.home_sports_team_id, e.away_sports_team_id, e.commence_at, e.venue
    FROM market_events e JOIN event_sources s ON s.market_event_id = e.id
    WHERE s.provider = ? AND s.external_id = ? LIMIT 1
  `).get(game.source === 'kalshi' ? 'kalshi' : 'espn', game.eventTicker || game.id)
  if (!event?.home_sports_team_id || !event.away_sports_team_id)
    return null
  const start = game.startsAt || event.commence_at
  const [away, home, forecast] = await Promise.all([
    teamIntelligence(db, Number(event.away_sports_team_id), start, game.venue || event.venue),
    teamIntelligence(db, Number(event.home_sports_team_id), start, game.venue || event.venue),
    game.state === 'pre' ? projectScore(db, game.league, { id: Number(event.id), starts: utcTime(start),
      home: Number(event.home_sports_team_id), away: Number(event.away_sports_team_id), neutral: game.neutralSite }).catch(() => null) : null,
  ])
  return { away, home, forecast }
}
