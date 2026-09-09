import type { Database } from '../../Support/db'
import type { HistoryActivity, HistoryBet, VenueHistory } from './history-types'

export interface UnifiedBet extends HistoryBet { key: string, venue: string, mode: 'live' | 'paper', source: string }
export interface UnifiedActivity extends HistoryActivity { key: string, venue: string, mode: 'live' | 'paper' }
interface Snapshot { account_id: number, venue: string, label: string, status: string, payload: string | null, synced_at: string | null, last_error: string | null }
interface OwnRow { id: number, exchange_account_id: number | null, market_external_id: string, venue: string, side: string, status: string, size: number, cost_basis: number, realized_pnl: number, settlement_price: number, opened_at: string, settled_at: string, question: string, mode: string, strategy: string }

export async function historyForUser(db: Database, userId: number) {
  const snapshots = await db.query<Snapshot>(`SELECT a.id AS account_id, a.venue, a.label, a.status, h.payload, h.synced_at, h.last_error
    FROM exchange_accounts a LEFT JOIN exchange_histories h ON h.exchange_account_id = a.id
    WHERE a.user_id = ? ORDER BY a.id`).all(userId)
  const own = await db.query<OwnRow>(`SELECT p.*, s.mode, s.name AS strategy, COALESCE(m.question, '') AS question
    FROM exchange_positions p JOIN trading_strategies s ON s.id = p.trading_strategy_id
    LEFT JOIN prediction_markets m ON m.id = p.prediction_market_id WHERE s.user_id = ? ORDER BY p.id`).all(userId)
  const bets: UnifiedBet[] = []
  const activity: UnifiedActivity[] = []
  const covered = new Set<string>()
  const notes = new Set<string>()
  for (const snapshot of snapshots) {
    if (!snapshot.payload) continue
    const history = (typeof snapshot.payload === 'string' ? JSON.parse(snapshot.payload) : snapshot.payload) as VenueHistory
    for (const row of history.bets) {
      const key = `${snapshot.account_id}:${row.marketId}`
      covered.add(key)
      bets.push({ ...row, key, venue: snapshot.venue, mode: 'live', source: snapshot.label || snapshot.venue })
    }
    for (const row of history.activity) activity.push({ ...row, key: `${snapshot.account_id}:${row.id}`, venue: snapshot.venue, mode: 'live' })
    for (const note of history.notes) notes.add(note)
  }
  for (const row of own) {
    const mode = row.mode === 'paper' || row.exchange_account_id === null ? 'paper' : 'live'
    // The exchange's lifetime market record already contains our own strategy's fills.
    if (mode === 'live' && covered.has(`${row.exchange_account_id}:${row.market_external_id}`)) continue
    const key = `strategy:${row.id}`
    bets.push({
      key, venue: row.venue, mode, source: row.strategy, marketId: row.market_external_id,
      title: row.question || row.market_external_id, side: row.side,
      status: row.status === 'settled' ? 'closed' : 'open', traded: Number(row.cost_basis),
      realized: row.status === 'settled' ? Number(row.realized_pnl) : 0,
      fees: mode === 'paper' ? 0 : null, at: row.settled_at || row.opened_at,
    })
    activity.push({ key: `${key}:buy`, id: `${key}:buy`, venue: row.venue, mode, marketId: row.market_external_id,
      title: row.question || row.market_external_id, side: row.side, kind: 'buy', size: Number(row.size), amount: Number(row.cost_basis), fee: mode === 'paper' ? 0 : null, at: row.opened_at })
    if (row.status === 'settled') activity.push({ key: `${key}:settlement`, id: `${key}:settlement`, venue: row.venue, mode,
      marketId: row.market_external_id, title: row.question || row.market_external_id, side: row.side,
      kind: 'settlement', size: Number(row.size), amount: Number(row.size) * Number(row.settlement_price), fee: 0, at: row.settled_at })
  }
  return {
    bets: bets.sort((a, b) => b.at.localeCompare(a.at)),
    activity: activity.sort((a, b) => b.at.localeCompare(a.at)),
    accounts: snapshots.map(row => ({ venue: row.venue, status: row.status, syncedAt: row.synced_at, error: row.last_error || '', imported: Boolean(row.payload) })),
    notes: [...notes],
  }
}

export function historyStats(bets: UnifiedBet[]) {
  const known = bets.filter(row => row.realized !== null)
  const net = (row: UnifiedBet) => (row.realized ?? 0) - (row.fees ?? 0)
  const closed = known.filter(row => row.status === 'closed')
  const wins = closed.filter(row => net(row) > 0.000001).length
  const losses = closed.filter(row => net(row) < -0.000001).length
  const values = known.map(net)
  const round = (value: number) => Math.round(value * 100) / 100
  return {
    bets: bets.length, open: bets.filter(row => row.status === 'open').length,
    traded: round(bets.reduce((sum, row) => sum + row.traded, 0)),
    realized: known.length ? round(values.reduce((sum, value) => sum + value, 0)) : bets.length ? null : 0,
    won: round(values.filter(value => value > 0).reduce((sum, value) => sum + value, 0)),
    lost: round(-values.filter(value => value < 0).reduce((sum, value) => sum + value, 0)),
    fees: round(bets.reduce((sum, row) => sum + (row.fees ?? 0), 0)),
    wins, losses, breakeven: closed.length - wins - losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    best: closed.length ? round(Math.max(...closed.map(net))) : null,
    worst: closed.length ? round(Math.min(...closed.map(net))) : null,
    unknownResults: bets.length - known.length,
    unknownFees: bets.filter(row => row.fees === null).length,
  }
}
