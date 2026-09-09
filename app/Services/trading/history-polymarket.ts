import type { HistoryActivity, HistoryBet, VenueHistory } from './history-types'
import { historyNumber as number, historyTime, uniqueHistory } from './history-types'

type Row = Record<string, any>

/** International wallet history is public data; this performs no wallet mutations. */
export async function polymarketHistory(address: string, base: string, fetcher: typeof fetch = fetch): Promise<VenueHistory> {
  async function pages(path: string, limit: number, maximumOffset: number): Promise<Row[]> {
    const rows: Row[] = []
    for (let offset = 0; offset <= maximumOffset; offset += limit) {
      const result = await fetcher(`${base}${path}&user=${encodeURIComponent(address)}&limit=${limit}&offset=${offset}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
      if (!result.ok) throw new Error('Polymarket International history could not be fetched.')
      const data = await result.json()
      if (!Array.isArray(data)) throw new Error('Polymarket returned an incomplete history page.')
      rows.push(...data)
      if (data.length < limit) return rows
    }
    throw new Error('Polymarket history exceeds the API pagination window. The previous import is preserved.')
  }
  const closed = await pages('/closed-positions?sortBy=TIMESTAMP&sortDirection=DESC', 50, 100000)
  const current = await pages('/positions?sizeThreshold=0', 500, 10000)
  const rows = await pages('/activity?sortBy=TIMESTAMP&sortDirection=DESC', 500, 10000)
  const activity = uniqueHistory<HistoryActivity>(rows.filter(row => ['TRADE', 'REDEEM'].includes(row.type)).map(row => ({
    id: `${row.transactionHash}:${row.type}:${row.asset || row.conditionId}:${row.side || ''}:${row.size}:${row.usdcSize}`,
    marketId: row.asset || row.conditionId, title: row.title || '', side: row.outcome || '',
    kind: row.type === 'REDEEM' ? 'settlement' : row.side === 'SELL' ? 'sell' : 'buy',
    size: number(row.size), amount: number(row.usdcSize), fee: null,
    at: historyTime(new Date(number(row.timestamp) * 1000).toISOString()),
  })), row => row.id)
  const latest = uniqueHistory<Row>([...closed.reverse().map(row => ({ ...row, closed: true })), ...current.map(row => ({ ...row, closed: number(row.size) === 0 }))], row => row.asset)
  const bets: HistoryBet[] = latest.map(row => ({
    marketId: row.asset, title: row.title || '', side: row.outcome || '', status: row.closed ? 'closed' : 'open',
    traded: activity.filter(event => event.marketId === row.asset && event.kind !== 'settlement').reduce((sum, event) => sum + event.amount, 0),
    realized: number(row.realizedPnl), fees: null,
    at: row.timestamp ? historyTime(new Date(number(row.timestamp) * 1000).toISOString()) : activity.find(event => event.marketId === row.asset)?.at || '',
  }))
  const covered = new Set(bets.map(row => row.marketId))
  for (const event of activity) {
    // A redemption can reference a condition rather than a tradable asset.
    if (event.kind === 'settlement' || covered.has(event.marketId)) continue
    const trades = activity.filter(row => row.marketId === event.marketId && row.kind !== 'settlement')
    bets.push({ marketId: event.marketId, title: event.title, side: event.side, status: 'open', realized: null, fees: null,
      traded: trades.reduce((sum, row) => sum + row.amount, 0), at: trades.map(row => row.at).sort().at(-1) || event.at })
    covered.add(event.marketId)
  }
  return { bets, activity, notes: ['Polymarket International does not provide fees in this history feed. Its realized results are shown before fees.'] }
}
