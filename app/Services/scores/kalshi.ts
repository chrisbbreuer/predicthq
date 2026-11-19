import type { Game, GameDetail, Team } from './espn'
import { cached } from '../prediction-markets/kalshi-public'

const BASE = process.env.KALSHI_API_BASE_URL || 'https://external-api.kalshi.com/trade-api/v2'
const SERIES: Record<string, string> = { nba: 'KXNBAGAME', wnba: 'KXWNBAGAME', nfl: 'KXNFLGAME', ncaaf: 'KXNCAAFGAME', ncaab: 'KXNCAAMBGAME', ncaaw: 'KXNCAAWBGAME', nhl: 'KXNHLGAME', mlb: 'KXMLBGAME', epl: 'KXEPLGAME', mls: 'KXMLSGAME', ucl: 'KXUCLGAME', laliga: 'KXLALIGAGAME', seriea: 'KXSERIEAGAME', bundesliga: 'KXBUNDESLIGAGAME', ligue1: 'KXLIGUE1GAME', 'uefa-nations': 'KXUEFANLGAME' }

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
  if (!res.ok)
    throw new Error(`Kalshi sports HTTP ${res.status}`)
  return res.json()
}

function score(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Status comes only from live_data, never inferred from a market's close time. */
export function gameFromMilestone(league: string, milestone: any, live: any): Game | null {
  const parts = String(milestone?.title ?? '').split(' at ')
  const startsAt = String(milestone?.start_date ?? '')
  if (parts.length !== 2 || !Number.isFinite(Date.parse(startsAt)))
    return null
  const details = live?.live_data?.details
  const status = String(details?.status ?? milestone?.details?.status ?? 'unknown').toLowerCase()
  const delayed = details?.live_data_delayed === true
  const state = details && /^(closed|finished|final|completed)$/.test(status) && !delayed && details.result_pending !== true ? 'post' : /^(live|in_progress|inprogress|in progress|playing|halftime)$/.test(status) ? 'in' : 'pre'
  const code = String(milestone.details?.main_game_event_ticker ?? '').split('-')[1]?.replace(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?/, '') ?? ''
  const team = (name: string, side: string): Team => ({
    name, location: name, shortName: name, abbreviation: league === 'nba' && code.length === 6 ? (side === 'away' ? code.slice(0, 3) : code.slice(3)) : name.split(' ')[0] ?? '',
    score: state === 'pre' || delayed ? null : score(details?.[`${side}_points`]),
    record: null, winner: state === 'post' && details?.winner === milestone?.details?.[`${side}_team_id`],
  })
  return {
    id: `kalshi-${milestone.id}`, league, startsAt, state,
    status: delayed ? 'Score feed delayed' : state === 'post' ? 'Final' : status === 'scheduled' ? 'Scheduled' : status,
    clock: state === 'in' && !delayed ? String(details?.period_remaining_time ?? '') : '',
    period: state === 'in' ? score(details?.period) ?? undefined : undefined,
    lastPlay: delayed ? '' : String(details?.last_play ?? ''),
    venue: null, broadcast: null, away: team(parts[0]!, 'away'), home: team(parts[1]!, 'home'),
    source: 'kalshi', sourceUpdatedAt: Number.isFinite(Number(details?.last_updated_ts)) ? new Date(Number(details.last_updated_ts) * 1000).toISOString() : String(milestone.last_updated_ts ?? ''),
    eventTicker: String(milestone.details?.main_game_event_ticker ?? ''),
  }
}

async function fromMilestone(league: string, milestone: any): Promise<Game | null> {
  const live = await cached(`kalshi-live:${milestone.id}`, 15_000, () => get(`/live_data/milestone/${encodeURIComponent(milestone.id)}`)).catch(() => null)
  return gameFromMilestone(league, milestone, live)
}

/** Exact event association also works for player props on that game. */
export async function kalshiGameFor(league: string, eventSuffix: string): Promise<Game | null> {
  if (!SERIES[league])
    return null
  const event = `${SERIES[league]}-${eventSuffix}`
  const milestones = await cached(`milestone-event:${event}`, 5 * 60_000, () => get(`/milestones?limit=100&related_event_ticker=${encodeURIComponent(event)}`))
  const milestone = milestones?.milestones?.find((m: any) => m?.details?.main_game_event_ticker === event || m?.primary_event_tickers?.includes(event))
  return milestone ? fromMilestone(league, milestone) : null
}

/** Used only when ESPN's scoreboard is unavailable. Bounded to three catalogue pages. */
export async function kalshiScoreboard(league: string, date?: string): Promise<Game[]> {
  if (date && /^\d{8}-\d{8}$/.test(date)) {
    const parse = (text: string) => Date.parse(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T12:00:00Z`)
    const start = parse(date.slice(0, 8))
    const end = parse(date.slice(9))
    const games: Game[] = []
    for (let at = start; at <= end && at < start + 7 * 86_400_000; at += 86_400_000)
      games.push(...await kalshiScoreboard(league, new Date(at).toISOString().slice(0, 10).replace(/-/g, '')))
    return games
  }
  const series = SERIES[league]
  if (!series)
    return []
  const day = date?.slice(0, 8) ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '')
  if (!/^\d{8}$/.test(day))
    return []
  const minimum = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`
  const list = await cached(`kalshi-scoreboard:${league}:${day}`, 60_000, async () => {
    const out: any[] = []
    let cursor = ''
    for (let page = 0; page < 3; page++) {
      const payload = await get(`/milestones?limit=500&category=Sports${league === 'nba' ? '&competition=NBA' : ''}&minimum_start_date=${encodeURIComponent(minimum)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      out.push(...(payload?.milestones ?? []))
      cursor = payload?.cursor ?? ''
      if (!cursor)
        break
    }
    return out.filter(m => String(m.details?.main_game_event_ticker ?? '').startsWith(`${series}-`) && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(m.start_date)).replace(/-/g, '') === day)
  })
  const games: Game[] = []
  for (const m of list) {
    const game = await fromMilestone(league, m)
    if (game)
      games.push(game)
  }
  return games
}

export async function kalshiGameDetail(league: string, id: string): Promise<GameDetail | null> {
  const uuid = id.replace(/^kalshi-/, '')
  if (!/^[a-f0-9-]{36}$/i.test(uuid))
    return null
  const payload = await cached(`milestone:${uuid}`, 5 * 60_000, () => get(`/milestones/${uuid}`))
  const milestone = payload?.milestone
  if (!String(milestone?.details?.main_game_event_ticker ?? '').startsWith(`${SERIES[league]}-`))
    return null
  const game = await fromMilestone(league, milestone)
  return game ? { ...game, box: { away: null, home: null }, periods: [], home: { ...game.home, line: [], total: String(game.home.score ?? '') }, away: { ...game.away, line: [], total: String(game.away.score ?? '') }, attendance: null, stats: [], odds: null, note: 'Scores from Kalshi. Player box scores are unavailable while ESPN cannot answer.' } : null
}
