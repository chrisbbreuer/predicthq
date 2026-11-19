/** Score archived sportsbook quotes and an independent, results-trained context overlay.
 * bun tools/audit-sportsbook-context.ts archive-entries.json historical-espn-results.json train-before-utc
 */
import type { WinnerQuoteArchiveEntry } from '../app/Services/trading/winner-quote-archive'
import type { TeamGame, WinnerContext } from '../app/Services/trading/winner-context'
import { fitContextFromOutcomes } from '../app/Services/trading/prediction-audit'
import { archiveSportsbookConsensus } from '../app/Services/trading/winner-quote-archive'
import { winnerContext } from '../app/Services/trading/winner-context'

interface Result { league: string, id: string, date: string, home: string, away: string, hs: number, as: number }

const [archiveFile, resultsFile, trainBefore] = process.argv.slice(2)
const cutoff = Date.parse(trainBefore ?? '')
if (!archiveFile || !resultsFile || !Number.isFinite(cutoff))
  throw new Error('Supply the archive, results and training cutoff')

const [entries, results] = await Promise.all([
  Bun.file(archiveFile).json() as Promise<WinnerQuoteArchiveEntry[]>,
  Bun.file(resultsFile).json() as Promise<Result[]>,
])
if (entries.some(entry => Date.parse(entry.cutoffAt) < cutoff))
  throw new Error('The training cutoff must precede every evaluated quote')

// The archived score feed has game start times but no final whistle timestamps.
const resultDelay = 8 * 3_600_000
const leagues = new Set(entries.map(entry => entry.league))
const priorByTeam = new Map<string, TeamGame[]>()
const seen = new Set<string>()
const training: Array<{ outcome: 0 | 1, context: WinnerContext }> = []
for (const result of results.toSorted((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
  const start = Date.parse(result.date)
  const id = `${result.league}:${result.id}`
  if (!leagues.has(result.league) || !Number.isFinite(start) || start + resultDelay >= cutoff || seen.has(id)
    || !Number.isFinite(result.hs) || !Number.isFinite(result.as))
    continue
  seen.add(id)
  const home = priorByTeam.get(`${result.league}:${result.home}`) ?? []
  const away = priorByTeam.get(`${result.league}:${result.away}`) ?? []
  const available = (history: TeamGame[]) => history.filter(game => game.at + resultDelay < start - 30 * 60_000).slice(0, 20)
  const context = winnerContext(available(home), available(away), result.league, start)
  if (context && result.hs !== result.as)
    training.push({ outcome: result.hs > result.as ? 1 : 0, context })
  home.unshift({ at: start, scored: result.hs, allowed: result.as })
  away.unshift({ at: start, scored: result.as, allowed: result.hs })
  priorByTeam.set(`${result.league}:${result.home}`, home)
  priorByTeam.set(`${result.league}:${result.away}`, away)
}

const weights = fitContextFromOutcomes(training)
// Team history and book prices overlap. Apply a fixed small adjustment,
// chosen before scoring the holdout, to avoid counting form twice in full.
const contextWeight = 0.10
const evaluated = entries.flatMap(entry => {
  const books = archiveSportsbookConsensus(entry)
  if (books === null || entry.context === null || entry.homeScore === entry.awayScore)
    return []
  const adjustment = contextWeight * entry.context.reduce((sum, value, i) => sum + value * weights[i]!, 0)
  const logOdds = Math.log(books / (1 - books)) + adjustment
  return [{ ...entry, outcome: Number(entry.homeScore > entry.awayScore), consensus: books, withContext: 1 / (1 + Math.exp(-logOdds)) }]
})

function score(key: 'consensus' | 'withContext') {
  const isCorrect = (row: typeof evaluated[number]) => Number(row[key] >= 0.5) === row.outcome
  const confidence = (p: number) => Math.max(p, 1 - p)
  const days = new Set(evaluated.map(row => row.day))
  const dailyPicks = [...days].flatMap(day => evaluated.filter(row => row.day === day)
    .sort((a, b) => confidence(b[key]) - confidence(a[key]) || a.ticker.localeCompare(b.ticker)).slice(0, 3))
  return {
    games: evaluated.length,
    wins: evaluated.filter(isCorrect).length,
    brier: evaluated.length ? evaluated.reduce((sum, row) => sum + (row[key] - row.outcome) ** 2, 0) / evaluated.length : null,
    dailyTopThree: { picks: dailyPicks.length, wins: dailyPicks.filter(isCorrect).length, tickers: dailyPicks.map(row => row.ticker) },
  }
}

console.log(JSON.stringify({
  providedGames: entries.length,
  pairedGames: evaluated.length,
  training: { completedGames: training.length, cutoff: trainBefore, weights, contextWeight, data: 'historical final scores only' },
  sportsbookConsensus: score('consensus'),
  sportsbookWithContext: score('withContext'),
  evaluated,
  omitted: entries.filter(entry => !evaluated.some(row => row.ticker === entry.ticker)).map(entry => ({ ticker: entry.ticker, books: entry.books.map(book => book.book) })),
}, null, 2))
