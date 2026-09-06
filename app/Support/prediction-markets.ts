import { Database } from './db'

/** Traders need this many scored fills before ranking as smart money. */
const MIN_RESOLVED = 2

/** Keep the public graph legible and below Vitess' 10k result-row ceiling. */
const MAX_GRAPH_LINKS = 160

export interface SmartTrader {
  id: number
  venue: string
  wallet: string
  alias: string
  tradeCount: number
  totalNotional: number
  avgTradeSize: number
  maxTradeSize: number
  resolvedTradeCount: number
  winningTradeCount: number
  winRate: number
  smartScore: number
  isWhale: boolean
}

export interface BigTrade {
  venue: string
  question: string
  side: string
  price: number
  size: number
  notional: number
  isWinner: number
  tradedAt: string
  alias: string
}

export interface GraphPayload {
  nodes: Array<{
    id: string
    kind: 'trader' | 'market'
    group: string
    value: number
    label: string
    winRate?: number
    smartScore?: number
    isWhale?: boolean
    venue?: string
    status?: string
  }>
  links: Array<{
    source: string
    target: string
    value: number
    trades: number
    wins: number
    losses: number
  }>
}

function openDb(): Database {
  return new Database()
}

/** Vitess returns aggregate and DECIMAL columns as strings or bigints. */
function numberOf(value: unknown): number {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

/**
 * Leaderboard of attributable traders ranked by smart-money score —
 * accounts that keep buying the side that ends up winning, with their
 * sizing profile. Whales ride along even with a thin resolved history.
 */
export async function loadSmartMoney(limit = 50, database?: Database): Promise<SmartTrader[]> {
  const db = database ?? openDb()
  try {
    return (await db.query<any>(`
      SELECT id, venue, external_id, alias, trade_count, total_notional, avg_trade_size,
            max_trade_size, resolved_trade_count, winning_trade_count, win_rate, smart_score, is_whale
      FROM market_traders
      WHERE resolved_trade_count >= ? OR is_whale = 1
      ORDER BY smart_score DESC, total_notional DESC
      LIMIT ?
    `).all(MIN_RESOLVED, limit)).map(r => ({
      id: numberOf(r.id),
      venue: r.venue,
      wallet: r.external_id,
      alias: r.alias || `${r.external_id.slice(0, 6)}…${r.external_id.slice(-4)}`,
      tradeCount: numberOf(r.trade_count),
      totalNotional: numberOf(r.total_notional),
      avgTradeSize: numberOf(r.avg_trade_size),
      maxTradeSize: numberOf(r.max_trade_size),
      resolvedTradeCount: numberOf(r.resolved_trade_count),
      winningTradeCount: numberOf(r.winning_trade_count),
      winRate: numberOf(r.win_rate),
      smartScore: numberOf(r.smart_score),
      isWhale: numberOf(r.is_whale) === 1,
    }))
  }
  finally {
    if (!database)
      db.close()
  }
}

/** Largest recent fills across both venues (Kalshi fills are anonymous). */
export async function loadBigTrades(limit = 30, database?: Database): Promise<BigTrade[]> {
  const db = database ?? openDb()
  try {
    return (await db.query<any>(`
      SELECT t.venue, pm.question, t.side, t.price, t.size, t.notional, t.is_winner AS isWinner,
            t.traded_at AS tradedAt, COALESCE(NULLIF(tr.alias, ''), tr.external_id, '') AS alias
      FROM market_trades t
      JOIN prediction_markets pm ON pm.id = t.prediction_market_id
      LEFT JOIN market_traders tr ON tr.id = t.market_trader_id
      ORDER BY t.notional DESC
      LIMIT ?
    `).all(limit)).map(row => ({
      venue: String(row.venue),
      question: String(row.question),
      side: String(row.side),
      price: numberOf(row.price),
      size: numberOf(row.size),
      notional: numberOf(row.notional),
      isWinner: numberOf(row.isWinner),
      tradedAt: String(row.tradedAt),
      alias: String(row.alias ?? ''),
    }))
  }
  finally {
    if (!database)
      db.close()
  }
}

/**
 * The money-flow network: top traders and the markets they bought,
 * shaped for a force-directed graph. Trader node size tracks notional,
 * market node size tracks volume through those traders, edge width
 * tracks the flow between them; wins/losses ride on each edge so the
 * UI can color winning flow.
 */
export async function loadGraph(traderLimit = 40, database?: Database): Promise<GraphPayload> {
  const db = database ?? openDb()
  try {
    const traders = await db.query<any>(`
      SELECT id, alias, external_id, total_notional, win_rate, smart_score, is_whale, resolved_trade_count
      FROM market_traders
      WHERE trade_count > 0 AND (resolved_trade_count >= ${MIN_RESOLVED} OR is_whale = 1 OR total_notional > 0)
      ORDER BY smart_score DESC, total_notional DESC
      LIMIT ?
    `).all(traderLimit)

    if (!traders.length)
      return { nodes: [], links: [] }

    const ids = traders.map(t => t.id)
    const placeholders = ids.map(() => '?').join(',')

    const flows = await db.query<any>(`
      SELECT t.market_trader_id AS tid, t.prediction_market_id AS mid,
            SUM(t.notional) AS notional, COUNT(*) AS trades,
            SUM(CASE WHEN t.is_winner = 1 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN t.is_winner = 0 THEN 1 ELSE 0 END) AS losses
      FROM market_trades t
      WHERE t.market_trader_id IN (${placeholders})
      GROUP BY t.market_trader_id, t.prediction_market_id
      ORDER BY notional DESC
      LIMIT ?
    `).all(...ids, MAX_GRAPH_LINKS)

    const marketIds = [...new Set(flows.map(f => f.mid))]
    const markets = marketIds.length
      ? await db.query<any>(`
          SELECT id, venue, question, status, volume
          FROM prediction_markets WHERE id IN (${marketIds.map(() => '?').join(',')})
        `).all(...marketIds)
      : []

    const nodes: GraphPayload['nodes'] = [
      ...traders.map(t => ({
        id: `t:${t.id}`,
        kind: 'trader' as const,
        group: numberOf(t.is_whale) === 1 ? 'whale' : (numberOf(t.smart_score) >= 25 && numberOf(t.resolved_trade_count) >= MIN_RESOLVED ? 'smart' : 'trader'),
        value: numberOf(t.total_notional),
        label: t.alias || `${t.external_id.slice(0, 6)}…`,
        winRate: numberOf(t.win_rate),
        smartScore: numberOf(t.smart_score),
        isWhale: numberOf(t.is_whale) === 1,
      })),
      ...markets.map(m => ({
        id: `m:${m.id}`,
        kind: 'market' as const,
        group: `market-${m.venue}`,
        value: numberOf(m.volume),
        label: m.question,
        venue: m.venue,
        status: m.status,
      })),
    ]

    const links: GraphPayload['links'] = flows.map(f => ({
      source: `t:${f.tid}`,
      target: `m:${f.mid}`,
      value: numberOf(f.notional),
      trades: numberOf(f.trades),
      wins: numberOf(f.wins),
      losses: numberOf(f.losses),
    }))

    return { nodes, links }
  }
  finally {
    if (!database)
      db.close()
  }
}
