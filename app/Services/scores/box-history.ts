import type { Database } from '../../Support/db'
import type { GameDetail } from './espn'
import { fetchGame } from './espn'

export const scoreLeagues = ['nba', 'wnba', 'ncaab', 'ncaaw', 'nfl', 'ncaaf', 'nhl', 'mlb', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1', 'ucl']

interface FinalGame {
  id: number
  league: string
  external_id: string
  home_score: number
  away_score: number
}

export interface FinalBox {
  teamStats: NonNullable<GameDetail['teamStats']>
  players: GameDetail['box']
  finalPlayAt: string
  neutralSite: boolean
}

/** Keep complete, final team summaries independently of the transient score cache. */
export async function captureGameBoxes(db: Database, limit = 6, league?: string, days = 45, now = Date.now()) {
  const leagues = league && scoreLeagues.includes(league) ? [league] : scoreLeagues
  const iso = (value: number) => new Date(value).toISOString()
  const games = await db.query<FinalGame>(`
    SELECT e.id, sp.slug AS league, s.external_id, r.home_score, r.away_score
    FROM market_events e JOIN sports sp ON sp.id = e.sport_id
    JOIN event_results r ON r.market_event_id = e.id
    JOIN event_sources s ON s.market_event_id = e.id AND s.provider = 'espn'
    LEFT JOIN game_box_scores b ON b.market_event_id = e.id
    WHERE e.commence_at BETWEEN ? AND ? AND r.completed = 1
      AND (b.id IS NULL OR (b.payload = '' AND b.captured_at < ?))
      AND sp.slug IN (${leagues.map(() => '?').join(',')})
    ORDER BY e.commence_at DESC LIMIT ${Math.max(1, Math.min(30, Math.floor(limit) || 1))}
  `).all(iso(now - days * 86_400_000), iso(now), iso(now - 6 * 3_600_000), ...leagues)
  let saved = 0
  for (const game of games) {
    const detail = await fetchGame(game.league, game.external_id, { ttlMs: 5 * 60_000 })
    let payload: FinalBox | null = null
    if (detail?.state === 'post' && detail.teamStats && detail.home.total !== '' && detail.away.total !== ''
      && Number(detail.home.total) === Number(game.home_score) && Number(detail.away.total) === Number(game.away_score)
      && Object.keys(detail.teamStats.home).length && Object.keys(detail.teamStats.away).length) {
      payload = { teamStats: detail.teamStats, players: detail.box, finalPlayAt: detail.finalPlayAt ?? '', neutralSite: detail.neutralSite === true }
      saved++
    }
    const at = new Date().toISOString()
    const row = { market_event_id: game.id, source: 'espn', captured_at: at, payload: payload ? JSON.stringify(payload) : '', updated_at: at }
    if (payload)
      await db.upsert('game_box_scores', [row], ['market_event_id'], ['source', 'captured_at', 'payload', 'updated_at'])
    else {
      await db.insertOrIgnore('game_box_scores', row)
      await db.query("UPDATE game_box_scores SET captured_at = ?, updated_at = ? WHERE market_event_id = ? AND payload = ''").run(at, at, game.id)
    }
  }
  return { checked: games.length, saved }
}
