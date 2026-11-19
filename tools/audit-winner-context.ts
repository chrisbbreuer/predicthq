/** Score archived game results against actual Kalshi bid/ask candles at T-30.
 * Usage: bun tools/audit-winner-context.ts games.json results.json candles-by-ticker.json [train-before]
 */
import type { KalshiCandle } from '../app/Services/prediction-markets/kalshi-public'
import type { AuditGame } from '../app/Services/trading/prediction-audit'
import type { TeamGame } from '../app/Services/trading/winner-context'
import { quoteAt } from '../app/Services/trading/backtest'
import { fitHistoricalWinnerContext, predictionAudit } from '../app/Services/trading/prediction-audit'
import { winnerContext } from '../app/Services/trading/winner-context'

interface Game { ticker: string, league: string, gameId: string, date: string, startsAt: string, selected: 'home' | 'away', outcome: 0 | 1 }
interface Result { league: string, id: string, date: string, home: string, away: string, hs: number, as: number }

const [gamesFile, resultsFile, quotesFile, trainBefore] = process.argv.slice(2)
if (!gamesFile || !resultsFile || !quotesFile)
  throw new Error('Usage: bun tools/audit-winner-context.ts games.json results.json candles-by-ticker.json [train-before]')

const [games, results, candles] = await Promise.all([
  Bun.file(gamesFile).json() as Promise<Game[]>,
  Bun.file(resultsFile).json() as Promise<Result[]>,
  Bun.file(quotesFile).json() as Promise<Record<string, KalshiCandle[]>>,
])
// Archived box-score results have start times but no final timestamp.
// The eight-hour delay conservatively excludes same-window results.
const resultDelay = 8 * 3_600_000
const gamesById = new Map<string, Result>()
const byTeam = new Map<string, TeamGame[]>()
for (const result of results) {
  const id = result.league + ':' + result.id
  const at = Date.parse(result.date)
  if (gamesById.has(id) || !Number.isFinite(at) || !Number.isFinite(result.hs) || !Number.isFinite(result.as))
    continue
  gamesById.set(id, result)
  for (const [team, scored, allowed] of [[result.home, result.hs, result.as], [result.away, result.as, result.hs]] as const) {
    const key = result.league + ':' + team
    const history = byTeam.get(key) ?? []
    history.push({ at, scored, allowed })
    byTeam.set(key, history)
  }
}
for (const history of byTeam.values())
  history.sort((a, b) => b.at - a.at)

const rows: AuditGame[] = []
const seen = new Set<string>()
for (const game of games) {
  const id = game.league + ':' + game.gameId
  const result = gamesById.get(id)
  if (seen.has(id) || (game.outcome !== 0 && game.outcome !== 1))
    continue
  const startsAt = Date.parse(game.startsAt)
  const checkpoint = startsAt / 1000 - 1800
  const quote = quoteAt(candles[game.ticker] ?? [], checkpoint)
  if (!quote || !Number.isFinite(startsAt))
    continue
  // The date can change when a fixture is rescheduled. Reject that join
  // until the result and the quote's underlying game agree on start time.
  if (result && (result.hs === result.as || Math.abs(Date.parse(result.date) - startsAt) > 60 * 60_000))
    continue
  const history = (team: string) => (byTeam.get(game.league + ':' + team) ?? [])
    .filter(row => row.at + resultDelay < quote.ts * 1000).slice(0, 20)
  const context = result
    ? winnerContext(history(result[game.selected]), history(result[game.selected === 'home' ? 'away' : 'home']), game.league, startsAt)
    : null
  rows.push({ ticker: game.ticker, league: game.league, day: game.date, at: quote.ts * 1000, settledAt: startsAt + resultDelay, bid: quote.bid, ask: quote.ask, outcome: game.outcome, context, consensus: null })
  seen.add(id)
}
const report = trainBefore
  ? fitHistoricalWinnerContext(rows, trainBefore)
  : { archiveGames: games.length, historicalResults: gamesById.size, ...predictionAudit(rows) }
console.log(JSON.stringify(report, null, 2))
