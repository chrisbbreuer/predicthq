import type { Database } from '../../Support/db'
import type { WinnerContext } from './winner-context'

const maxQuoteAgeMs = 10 * 60_000
const supportedBooks = new Set(['pinnacle', 'draftkings', 'fanduel', 'bet365', 'betmgm', 'caesars', 'bovada.lv', 'betonline.ag', 'hardrockbet'])

export interface HistoricOffer {
  price: number
  createdAt: string
  id?: number | null
}

export interface HistoricObservation {
  book: string
  side: 'home' | 'away'
  price: number
  createdAt: string
  active: boolean
}

export interface HistoricSportsbookPair {
  book: string
  home: HistoricOffer
  away: HistoricOffer
}

export interface WinnerQuoteArchiveEntry {
  ticker: string
  league: string
  fixtureId: string
  startsAt: string
  cutoffAt: string
  day: string
  home: string
  away: string
  homeScore: number
  awayScore: number
  context: WinnerContext | null
  observations: HistoricObservation[]
  books: HistoricSportsbookPair[]
}

function fresh(offer: HistoricOffer, cutoff: number): boolean {
  const age = cutoff - Date.parse(offer.createdAt)
  return Number.isFinite(age) && age >= 0 && age <= maxQuoteAgeMs && Number.isFinite(offer.price) && offer.price > 1
}

export function archiveSportsbookConsensus(entry: WinnerQuoteArchiveEntry): number | null {
  const cutoff = Date.parse(entry.cutoffAt)
  const books = new Map<string, number>()
  for (const { book, home, away } of entry.books) {
    if (!supportedBooks.has(book) || !fresh(home, cutoff) || !fresh(away, cutoff))
      continue
    const total = 1 / home.price + 1 / away.price
    if (total >= 0.98 && total <= 1.15)
      books.set(book, (1 / home.price) / total)
  }
  if (books.size < 2)
    return null
  return [...books.values()].reduce((sum, price) => sum + price, 0) / books.size
}

/** Store timestamped provider evidence and explicit coverage separately from live captures. */
export async function importWinnerQuoteArchive(db: Database, entries: WinnerQuoteArchiveEntry[]) {
  const importedAt = Date.now()
  const rows = entries.map(entry => {
    const cutoff = Date.parse(entry.cutoffAt)
    const start = Date.parse(entry.startsAt)
    if (!entry.ticker || !entry.league || !entry.fixtureId || !entry.home || !entry.away || !Number.isFinite(cutoff)
      || start - cutoff !== 30 * 60_000 || !Array.isArray(entry.books) || !Array.isArray(entry.observations)
      || !Number.isFinite(entry.homeScore) || !Number.isFinite(entry.awayScore)
      || entry.books.some(({ book, home, away }) => !supportedBooks.has(book) || !fresh(home, cutoff) || !fresh(away, cutoff)
        || !entry.observations.some(row => row.book === book && row.side === 'home' && row.active && row.createdAt === home.createdAt && row.price === home.price)
        || !entry.observations.some(row => row.book === book && row.side === 'away' && row.active && row.createdAt === away.createdAt && row.price === away.price)))
      throw new Error(`Invalid historical quote evidence for ${entry.ticker}`)
    return {
      ticker: entry.ticker,
      source: 'oddspapi',
      cutoff_at_ms: cutoff,
      league: entry.league,
      payload: JSON.stringify(entry),
      imported_at_ms: importedAt,
    }
  })
  if (rows.length > 0)
    await db.upsert('winner_quote_archives', rows, ['ticker', 'source', 'cutoff_at_ms'], ['payload', 'imported_at_ms'])
}

export async function readWinnerQuoteArchive(db: Database, start: number, end: number): Promise<WinnerQuoteArchiveEntry[]> {
  const rows = await db.query<{ payload: string }>(`
    SELECT payload FROM winner_quote_archives
    WHERE cutoff_at_ms >= ? AND cutoff_at_ms < ? AND source = 'oddspapi'
    ORDER BY cutoff_at_ms, ticker
  `).all(start, end)
  return rows.map(row => JSON.parse(row.payload) as WinnerQuoteArchiveEntry)
}
