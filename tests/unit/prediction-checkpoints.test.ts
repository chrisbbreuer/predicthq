import type { LiveGame } from '../../app/Services/trading/live-games'
import type { Database } from '../../app/Support/db'
import { describe, expect, it } from 'bun:test'
import { toMarketInfo } from '../../app/Services/prediction-markets/kalshi-public'
import { auditRecordedCheckpoints, capturePredictionCheckpoint, settlePredictionCheckpoints } from '../../app/Services/trading/prediction-checkpoints'
import { schemaFor } from '../support/schema'

describe('T-30 winner checkpoints', () => {
  it('captures unchanged but recently observed odds, keeps the quotes, and settles from Kalshi', async () => {
    const raw = schemaFor(':memory:', [
      'sports', 'sports_teams', 'market_events', 'event_results', 'event_sources', 'markets', 'selections',
      'bookmakers', 'odds', 'prediction_checkpoints',
    ])
    const db = raw as unknown as Database
    const start = '2026-11-19T03:30:00.000Z'
    const now = Date.parse(start) - 31 * 60_000
    const ticker = 'KXNBAGAME-26NOV18PHXSAC-SAC'
    const game = { gameId: '401', league: 'nba', selected: 'home', state: 'pre', startsAt: start } as LiveGame
    const bookStamp = new Date(now - 2 * 60_000).toISOString()
    const olderStamp = new Date(now - 20 * 60_000).toISOString()
    const market = toMarketInfo({ ticker, status: 'active', yes_bid_dollars: '0.49', yes_ask_dollars: '0.51' })
    try {
      raw.run("INSERT INTO sports (id, slug, title, grouping) VALUES (1, 'nba', 'NBA', 'Basketball')")
      raw.run("INSERT INTO market_events (id, sport_id, title, commence_at) VALUES (1, 1, 'Phoenix at Sacramento', ?)", [start])
      raw.run("INSERT INTO event_sources (market_event_id, provider, external_id) VALUES (1, 'espn', '401')")
      raw.run("INSERT INTO markets (id, market_event_id, market_type, period) VALUES (1, 1, 'h2h', 'full_game')")
      raw.run("INSERT INTO selections (id, market_id, label, side) VALUES (1, 1, 'Sacramento', 'home'), (2, 1, 'Phoenix', 'away')")
      for (const [id, name, updated] of [[1, 'pinnacle', bookStamp], [2, 'draftkings', bookStamp], [3, 'kalshi', bookStamp], [4, 'fanduel', olderStamp]] as const) {
        raw.run("INSERT INTO bookmakers (id, slug, name, kind) VALUES (?, ?, ?, 'sportsbook')", [id, name, name])
        for (const [selection, price] of [[1, 1.8], [2, 2.04]])
          raw.run('INSERT INTO odds (selection_id, bookmaker_id, price, available, observed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [selection, id, price, olderStamp, updated])
      }
      const oneSided = { ...market, yesBid: 0.99, yesAsk: 1 }
      expect(await capturePredictionCheckpoint(db, ticker, game, () => now - 30_000, async () => oneSided)).toEqual({ captured: 1, paired: 0 })
      const coverage = await auditRecordedCheckpoints(db, now)
      expect(coverage.quotedBySportsbooks).toBe(1)
      expect(coverage.usableKalshiQuotes).toBe(0)
      expect(coverage.upcoming).toHaveLength(0)
      expect(await capturePredictionCheckpoint(db, ticker, game, () => now, async () => market)).toEqual({ captured: 1, paired: 1 })
      expect((await auditRecordedCheckpoints(db, now)).capturedWithConsensus).toBe(1)
      const row = await db.query<{ payload: string }>('SELECT payload FROM prediction_checkpoints ORDER BY captured_at DESC').get()
      const payload = JSON.parse(row!.payload)
      expect(payload.observations.map((b: { book: string }) => b.book)).toEqual(['draftkings', 'pinnacle'])
      expect(payload.observations[0].home.price).toBe(1.8)
      expect(payload.bid).toBe(0.49)
      expect(await capturePredictionCheckpoint(db, ticker, game, () => now + 120_000, async () => market)).toEqual({ captured: 0, paired: 0 })
      await settlePredictionCheckpoints(db, Date.parse(start) + 6 * 3_600_000, async () => new Map([[ticker, { ...market, status: 'finalized', result: 'yes' }]]))
      const report = await auditRecordedCheckpoints(db, Date.parse(start) + 7 * 3_600_000)
      expect(report.pairedSettled).toBe(1)
      expect(report.paired.market.brier).toBe(0.25)
    }
    finally {
      raw.close()
    }
  })
})
