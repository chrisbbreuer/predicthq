import type { WinnerQuoteArchiveEntry } from '../../app/Services/trading/winner-quote-archive'
import type { Database } from '../../app/Support/db'
import { expect, it } from 'bun:test'
import { archiveSportsbookConsensus, importWinnerQuoteArchive, readWinnerQuoteArchive } from '../../app/Services/trading/winner-quote-archive'
import { schemaFor } from '../support/schema'

it('archives observed quotes idempotently and rejects an unobserved leg', async () => {
  const raw = schemaFor(':memory:', ['winner_quote_archives'])
  const db = raw as unknown as Database
  const cutoffAt = '2026-11-12T23:30:00Z'
  const offer = { createdAt: '2026-11-12T23:29:01.011Z', price: 1.91 }
  const books = ['pinnacle', 'draftkings'].map(book => ({ book, home: offer, away: offer }))
  const entry: WinnerQuoteArchiveEntry = {
    ticker: 'test', league: 'nba', fixtureId: 'fixture', startsAt: '2026-11-13T00:00:00Z', cutoffAt,
    day: '2026-11-12', home: 'Home', away: 'Away', homeScore: 100, awayScore: 90, context: null, books,
    observations: books.flatMap(({ book }) => (['home', 'away'] as const).map(side => ({ ...offer, book, side, active: true }))),
  }
  try {
    await expect(importWinnerQuoteArchive(db, [{ ...entry, observations: entry.observations.slice(1) }])).rejects.toThrow('Invalid historical quote evidence')
    await importWinnerQuoteArchive(db, [entry])
    await importWinnerQuoteArchive(db, [entry])
    const at = Date.parse(cutoffAt)
    const rows = await readWinnerQuoteArchive(db, at, at + 1)
    expect(rows).toEqual([entry])
    expect(archiveSportsbookConsensus(rows[0]!)).toBe(0.5)
    expect(archiveSportsbookConsensus({ ...entry, books: [...books.slice(0, 1), { ...books[1]!, book: 'kalshi' }] })).toBeNull()
  }
  finally {
    raw.close()
  }
})
