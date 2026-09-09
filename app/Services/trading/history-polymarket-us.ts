import type { HistoryActivity, HistoryBet, VenueHistory } from './history-types'
import { historyNumber as number, historyTime, uniqueHistory } from './history-types'

type Row = Record<string, any>
type Read = (path: string) => Promise<Row>

function usd(value: any): number {
  if (value?.currency !== 'USD') throw new Error('Polymarket US history contains an unsupported currency.')
  return number(value.value)
}

function title(row: Row): string {
  const legs = row.comboLegDetails || row.beforePosition?.comboLegDetails || []
  return row.marketMetadata?.title || row.beforePosition?.marketMetadata?.title
    || (legs.length ? `${legs.length}-leg combo: ${legs.map((leg: Row) => leg.outcome && !['Yes', 'No'].includes(leg.outcome) ? leg.outcome : leg.title).join(' · ')}` : '')
}

async function paged(read: Read, path: string, field: string): Promise<Row[]> {
  const rows: Row[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (let page = 0; page < 200; page++) {
    const data = await read(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (field === 'positions') {
      if (!data.positions || typeof data.positions !== 'object' || Array.isArray(data.positions)) throw new Error('Missing position history.')
      rows.push(...Object.entries(data.positions).map(([marketSlug, value]) => ({ ...(value as Row), marketSlug })))
    }
    else {
      if (!Array.isArray(data[field])) throw new Error('Missing activity history.')
      rows.push(...data[field])
    }
    if (data.eof || !data.nextCursor) return rows
    if (seen.has(data.nextCursor)) break
    seen.add(data.nextCursor)
    cursor = data.nextCursor
  }
  throw new Error('Polymarket US history pagination did not complete.')
}

export async function polymarketUsHistory(read: Read): Promise<VenueHistory> {
  const rows = await paged(read, '/v1/portfolio/activities', 'activities')
  const positions = await paged(read, '/v1/portfolio/positions', 'positions')
  const activity: HistoryActivity[] = []
  const latest = new Map<string, Row>()
  const titles = new Map<string, string>()
  function remember(market: string, position: Row) {
    if (!latest.has(market) || historyTime(position.updateTime) > historyTime(latest.get(market)!.updateTime)) latest.set(market, position)
  }
  for (const row of positions) { remember(row.marketSlug, row); titles.set(row.marketSlug, title(row)) }
  for (const row of rows) {
    if (row.type === 'ACTIVITY_TYPE_TRADE') {
      const trade = row.trade
      if (!trade?.id || !trade.marketSlug) throw new Error('Incomplete trade history.')
      const execution = trade.isAggressor ? trade.aggressorExecution : trade.passiveExecution
      const intent = String(execution?.order?.intent || '')
      const side = intent.includes('SHORT') ? 'no' : intent.includes('LONG') ? 'yes' : ''
      const size = Math.abs(number(trade.qtyDecimal ?? trade.qty))
      const rawPrice = usd(execution?.lastPx ?? trade.price)
      const price = side === 'no' ? 1 - rawPrice : rawPrice
      if (price < 0 || price > 1) throw new Error('Invalid trade price.')
      const fee = execution?.commissionNotionalCollected ? usd(execution.commissionNotionalCollected) : null
      const caption = title(trade) || execution?.order?.marketMetadata?.title || ''
      if (caption) titles.set(trade.marketSlug, caption)
      activity.push({
        id: `trade:${trade.id}`, marketId: trade.marketSlug, title: caption, side,
        kind: intent.includes('SELL') ? 'sell' : intent.includes('BUY') ? 'buy' : 'trade',
        size, amount: size * price, fee, at: historyTime(trade.createTime),
        voided: ['TRADE_STATE_BUSTED', 'TRADE_STATE_REJECTED'].includes(trade.state),
      })
    }
    else if (row.type === 'ACTIVITY_TYPE_POSITION_RESOLUTION') {
      const resolution = row.positionResolution
      if (!resolution?.marketSlug || !resolution.beforePosition || !resolution.afterPosition) throw new Error('Incomplete settlement history.')
      const before = resolution.beforePosition
      const after = resolution.afterPosition
      const size = Math.abs(number(before.netPositionDecimal ?? before.netPosition))
      const realized = usd(after.realized) - usd(before.realized)
      // Reported realized excludes fees. baseCost avoids counting entry fees as payout.
      const baseCost = before.baseCost ? Math.abs(usd(before.baseCost)) : Math.abs(usd(before.cost)) - (before.fees ? usd(before.fees) : 0)
      const caption = title(resolution)
      if (caption) titles.set(resolution.marketSlug, caption)
      remember(resolution.marketSlug, { ...after, updateTime: resolution.updateTime })
      activity.push({
        id: `settlement:${resolution.marketSlug}:${resolution.tradeId || resolution.updateTime}`,
        marketId: resolution.marketSlug, title: caption,
        side: number(before.netPositionDecimal ?? before.netPosition) < 0 ? 'no' : 'yes',
        kind: 'settlement', size, amount: Math.max(0, baseCost + realized), fee: 0,
        at: historyTime(resolution.updateTime),
      })
    }
  }
  const events = uniqueHistory(activity, row => row.id)
  const markets = new Set([...latest.keys(), ...events.map(row => row.marketId)])
  const bets: HistoryBet[] = [...markets].map((marketId) => {
    const position = latest.get(marketId)
    const trades = events.filter(row => row.marketId === marketId && row.kind !== 'settlement' && !row.voided)
    const fees = trades.every(row => row.fee !== null) ? trades.reduce((sum, row) => sum + (row.fee ?? 0), 0) : null
    return {
      marketId, title: titles.get(marketId) || '',
      side: position ? number(position.netPositionDecimal ?? position.netPosition) < 0 ? 'no' : 'yes' : '',
      status: position && number(position.netPositionDecimal ?? position.netPosition) === 0 ? 'closed' : 'open',
      traded: trades.reduce((sum, row) => sum + row.amount, 0),
      realized: position?.realized ? usd(position.realized) : null, fees,
      at: position ? historyTime(position.updateTime) : trades.at(-1)?.at || new Date().toISOString(),
    }
  })
  return { bets, activity: events, notes: [] }
}
