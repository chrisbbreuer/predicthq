import type { Database } from '../../Support/db'
import type { LiveGame } from './live-games'
import { norm } from '../../Support/keys'

const MAX_QUOTE_AGE_MS = 15 * 60_000
const MIN_BOOKS = 2
const THREE_WAY = new Set(['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uefa-nations', 'mls'])

export interface SportsbookForecast {
  probability: number
  books: string[]
}

async function matchEvent(db: Database, game: LiveGame): Promise<number | null> {
  if (/^\d+$/.test(game.gameId)) {
    const source = await db.query<{ market_event_id: number }>(`
      SELECT market_event_id FROM event_sources WHERE provider = 'espn' AND external_id = ?
    `).get(game.gameId)
    if (source)
      return Number(source.market_event_id)
  }

  // The native feed can ingest prices before it has an ESPN link. Require
  // both teams, the league and a unique start within an hour.
  const start = Date.parse(game.startsAt)
  const matches = await db.query<{ id: number }>(`
    SELECT e.id FROM market_events e
    JOIN sports sp ON sp.id = e.sport_id
    JOIN sports_teams home ON home.id = e.home_sports_team_id
    JOIN sports_teams away ON away.id = e.away_sports_team_id
    WHERE sp.slug = ? AND home.search_key = ? AND away.search_key = ?
      AND e.commence_at BETWEEN ? AND ?
    LIMIT 2
  `).all(game.league, norm(game.home.name), norm(game.away.name), new Date(start - 3_600_000).toISOString(), new Date(start + 3_600_000).toISOString())
  return matches.length === 1 ? Number(matches[0]!.id) : null
}

/** An equal-weight average of complete, de-vigged sportsbook moneylines.
 * Use change records known by the quote time. The archive doesn't record
 * every re-observation, so old records cannot establish fresh coverage.
 */
export async function sportsbookConsensus(db: Database, game: LiveGame, asOf: number): Promise<SportsbookForecast | null> {
  const sides = THREE_WAY.has(game.league) ? ['home', 'away', 'draw'] : ['home', 'away']
  if (!game.selected || !Number.isFinite(asOf) || !Number.isFinite(Date.parse(game.startsAt)) || asOf >= Date.parse(game.startsAt))
    return null
  const eventId = await matchEvent(db, game)
  if (eventId === null)
    return null

  const rows = await db.query<{ market_id: number | string, bookmaker: string, side: string, price: number | string }>(`
    SELECT m.id AS market_id, b.slug AS bookmaker, s.side, os.price
    FROM markets m
    JOIN selections s ON s.market_id = m.id
    JOIN odds_snapshots os ON os.selection_id = s.id
    JOIN bookmakers b ON b.id = os.bookmaker_id
    WHERE m.market_event_id = ? AND m.market_type = 'h2h' AND m.period = 'full_game'
      AND b.kind = 'sportsbook' AND b.slug NOT IN ('kalshi', 'polymarket')
      AND os.captured_at >= ?
      AND os.captured_at = (
        SELECT MAX(last_quote.captured_at)
        FROM odds_snapshots last_quote
        WHERE last_quote.selection_id = os.selection_id AND last_quote.bookmaker_id = os.bookmaker_id
          AND last_quote.captured_at <= ?
      )
    ORDER BY m.id, b.slug, s.id
  `).all(eventId, new Date(asOf - MAX_QUOTE_AGE_MS).toISOString(), new Date(asOf).toISOString())

  const markets = new Map<string, Map<string, Map<string, number>>>()
  for (const row of rows) {
    const marketId = String(row.market_id)
    const books = markets.get(marketId) ?? new Map()
    const quotes = books.get(row.bookmaker) ?? new Map()
    // Two selections for one side make the market ambiguous.
    quotes.set(row.side, quotes.has(row.side) ? Number.NaN : Number(row.price))
    books.set(row.bookmaker, quotes)
    markets.set(marketId, books)
  }

  const forecasts: SportsbookForecast[] = []
  for (const books of markets.values()) {
    const names: string[] = []
    let sum = 0
    for (const [book, quotes] of books) {
      if (quotes.size !== sides.length || sides.some(side => !(quotes.get(side)! > 1) || !Number.isFinite(quotes.get(side))))
        continue
      const total = sides.reduce((acc, side) => acc + 1 / quotes.get(side)!, 0)
      if (total < 0.98 || total > (sides.length === 3 ? 1.25 : 1.15))
        continue
      sum += (1 / quotes.get(game.selected)!) / total
      names.push(book)
    }
    if (names.length >= MIN_BOOKS)
      forecasts.push({ probability: sum / names.length, books: names })
  }
  // A fixture should have exactly one full-game moneyline.
  return forecasts.length === 1 ? forecasts[0]! : null
}
