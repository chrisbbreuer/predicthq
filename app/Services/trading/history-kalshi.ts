import type { HistoryActivity, HistoryBet, VenueHistory } from './history-types'
import { historyNumber as number, historyTime, uniqueHistory } from './history-types'

type Row = Record<string, any>
type Read = (path: string) => Promise<Row>

async function pages(read: Read, path: string, field: string): Promise<Row[]> {
  const result: Row[] = []
  const cursors = new Set<string>()
  let cursor = ''
  for (let page = 0; page < 200; page++) {
    const data = await read(`${path}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!Array.isArray(data[field])) throw new Error('Kalshi returned an incomplete history page.')
    result.push(...data[field])
    if (!data.cursor) return result
    if (cursors.has(data.cursor)) break
    cursors.add(data.cursor)
    cursor = data.cursor
  }
  throw new Error('Kalshi history pagination did not complete.')
}

/** Use venue P&L, not settlement revenue minus buys: Kalshi can net pairs early. */
export async function kalshiHistory(read: Read, subaccount: number): Promise<VenueHistory> {
  const current = await pages(read, `/portfolio/positions?subaccount=${subaccount}&count_filter=total_traded`, 'market_positions')
  const archived = await pages(read, `/historical/positions?subaccount=${subaccount}`, 'market_positions')
  const fills = await pages(read, `/portfolio/fills?subaccount=${subaccount}`, 'fills')
  // Historical fills do not support the subaccount query; filter their explicit account field.
  const oldFills = await pages(read, '/historical/fills?', 'fills')
  const settlements = uniqueHistory(await pages(read, `/portfolio/settlements?subaccount=${subaccount}`, 'settlements'), row => String(row.ticker))
  const activity: HistoryActivity[] = uniqueHistory([...oldFills, ...fills], row => String(row.fill_id || row.trade_id))
    .filter(row => Number(row.subaccount_number ?? 0) === subaccount)
    .map((row) => {
      const legacy = row.action === 'buy' || row.action === 'sell'
      const side = legacy ? row.side : row.outcome_side
      const price = number(side === 'no' ? row.no_price_dollars : row.yes_price_dollars)
      const size = number(row.count_fp)
      if (!(row.fill_id || row.trade_id) || !row.ticker || !['yes', 'no'].includes(side) || size < 0 || price < 0 || price > 1)
        throw new Error('Kalshi returned an invalid history fill.')
      return {
        id: `fill:${row.fill_id || row.trade_id}`, marketId: row.ticker, title: '', side,
        kind: legacy ? row.action : 'trade', size, amount: size * price,
        fee: number(row.fee_cost), at: historyTime(row.created_time || new Date(number(row.ts) * 1000).toISOString()),
      }
    })
  for (const row of settlements) {
    const yes = number(row.yes_count_fp)
    const no = number(row.no_count_fp)
    activity.push({
      id: `settlement:${row.exchange_index ?? 0}:${row.ticker}:${row.settled_time}`,
      marketId: row.ticker, title: '', side: yes && no ? 'yes + no' : yes ? 'yes' : 'no',
      kind: 'settlement', size: yes + no, amount: number(row.revenue) / 100,
      // Settlement fee_cost repeats fees already attached to fills.
      fee: 0, at: historyTime(row.settled_time),
    })
  }
  const bets: HistoryBet[] = uniqueHistory([...archived, ...current], row => String(row.ticker)).map(row => ({
    marketId: row.ticker, title: '', side: number(row.position_fp) < 0 ? 'no' : number(row.position_fp) > 0 ? 'yes' : 'closed',
    status: number(row.position_fp) === 0 ? 'closed' : 'open',
    traded: activity.filter(event => event.marketId === row.ticker && event.kind !== 'settlement').reduce((sum, event) => sum + event.amount, 0), realized: number(row.realized_pnl_dollars),
    fees: number(row.fees_paid_dollars), at: historyTime(row.last_updated_ts),
  }))
  const covered = new Set(bets.map(row => row.marketId))
  for (const row of settlements) {
    if (covered.has(row.ticker)) continue
    const yes = number(row.yes_count_fp)
    const no = number(row.no_count_fp)
    const value = row.market_result === 'yes' ? 1 : row.market_result === 'no' ? 0 : number(row.value) / 100
    if (value < 0 || value > 1) throw new Error('Invalid Kalshi settlement value.')
    // Counts and cost basis include offsetting contracts whose collateral may
    // already have been returned. Value all of them; revenue alone omits that cash.
    bets.push({
      marketId: row.ticker, title: '', side: yes && no ? 'yes + no' : yes ? 'yes' : 'no', status: 'closed',
      traded: activity.filter(event => event.marketId === row.ticker && event.kind !== 'settlement').reduce((sum, event) => sum + event.amount, 0),
      realized: yes * value + no * (1 - value) - number(row.yes_total_cost_dollars) - number(row.no_total_cost_dollars),
      fees: number(row.fee_cost), at: historyTime(row.settled_time),
    })
    covered.add(row.ticker)
  }
  for (const event of activity) {
    if (covered.has(event.marketId)) continue
    const trades = activity.filter(row => row.marketId === event.marketId && row.kind !== 'settlement')
    bets.push({ marketId: event.marketId, title: '', side: event.side, status: 'open', realized: null,
      traded: trades.reduce((sum, row) => sum + row.amount, 0), fees: trades.reduce((sum, row) => sum + (row.fee ?? 0), 0),
      at: trades.map(row => row.at).sort().at(-1) || event.at })
    covered.add(event.marketId)
  }
  // Market metadata is optional: a missing title must not discard financial history.
  const titles = new Map<string, string>()
  const ids = [...covered]
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50)
    for (const endpoint of ['/markets', '/historical/markets']) {
      const missing = batch.filter(id => !titles.has(id))
      if (!missing.length) break
      try {
        const data = await read(`${endpoint}?tickers=${encodeURIComponent(missing.join(','))}&limit=200`)
        for (const market of data.markets || []) if (market.ticker && market.title) titles.set(market.ticker, market.title)
      }
      catch { /* Fall back to the local catalog or ticker. */ }
    }
  }
  for (const row of [...bets, ...activity]) row.title = titles.get(row.marketId) || ''
  return { bets, activity: uniqueHistory(activity, row => row.id), notes: [] }
}
