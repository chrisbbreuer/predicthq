import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database as Sqlite } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { Database } from '../../app/Support/db'
import { historyForUser, historyStats } from '../../app/Services/trading/history'
import type { UnifiedBet } from '../../app/Services/trading/history'
import { kalshiHistory } from '../../app/Services/trading/history-kalshi'
import { polymarketUsHistory } from '../../app/Services/trading/history-polymarket-us'
import { polymarketHistory } from '../../app/Services/trading/history-polymarket'
import { syncHistory } from '../../app/Services/trading/history-sync'
import { migrationsFor } from '../support/schema'

const at = '2026-09-01T12:00:00Z'
const amount = (value: string) => ({ value, currency: 'USD' })
const position = (marketId = 'M') => ({ ticker: marketId, position_fp: '0', total_traded_dollars: '5', realized_pnl_dollars: '3', fees_paid_dollars: '0.2', last_updated_ts: at })
const fill = { fill_id: 'F', ticker: 'M', side: 'yes', action: 'buy', count_fp: '10', yes_price_dollars: '0.5', no_price_dollars: '0.5', fee_cost: '0.2', created_time: at, subaccount_number: 0 }
const bet = (values: Partial<UnifiedBet> = {}): UnifiedBet => ({ key: '1', marketId: 'M', venue: 'kalshi', mode: 'live', source: 'kalshi', title: 'Market', side: 'yes', status: 'closed', traded: 5, realized: 3, fees: 0.2, at, ...values })

describe('exchange history normalization', () => {
  it('includes historical pages, deduplicates overlaps, scopes subaccounts, and uses realized P&L after early netting', async () => {
    const paths: string[] = []
    const history = await kalshiHistory(async (path) => {
      paths.push(path)
      if (path.startsWith('/portfolio/positions')) return { market_positions: [position()], cursor: '' }
      if (path.startsWith('/historical/positions')) return path.includes('cursor=next') ? { market_positions: [position('OLDER')], cursor: '' } : { market_positions: [position()], cursor: 'next' }
      if (path.startsWith('/portfolio/fills')) return { fills: [fill], cursor: '' }
      if (path.startsWith('/historical/fills')) return { fills: [fill, { ...fill, fill_id: 'FOREIGN', subaccount_number: 1 }], cursor: '' }
      return { settlements: [{ ticker: 'M', settled_time: at, yes_count_fp: '10', no_count_fp: '10', revenue: 0 }], cursor: '' }
    }, 0)
    expect(history.bets).toHaveLength(2)
    expect(history.activity.filter(row => row.kind === 'buy')).toHaveLength(1)
    expect(history.bets[0]?.realized).toBe(3)
    expect(history.activity.find(row => row.kind === 'settlement')?.amount).toBe(0)
    expect(paths.some(path => path.includes('cursor=next'))).toBe(true)
  })

  it('rejects repeated cursors rather than publishing partial totals', async () => {
    await expect(kalshiHistory(async () => ({ market_positions: [position()], cursor: 'loop' }), 0)).rejects.toThrow('pagination')
  })

  it('includes settled markets absent from positions and accounts for returned collateral', async () => {
    const history = await kalshiHistory(async (path) => {
      if (path.includes('/positions')) return { market_positions: [] }
      if (path.includes('/fills')) return { fills: [{ ...fill, ticker: 'SETTLED' }, { ...fill, fill_id: 'UNKNOWN', ticker: 'UNKNOWN' }] }
      if (path.includes('/markets')) return { markets: [{ ticker: 'SETTLED', title: 'A settled prediction' }] }
      return { settlements: [{ ticker: 'SETTLED', settled_time: at, market_result: 'no', yes_count_fp: '10', no_count_fp: '10', yes_total_cost_dollars: '5', no_total_cost_dollars: '3', revenue: 0, fee_cost: '0.2' }] }
    }, 0)
    expect(history.bets.find(row => row.marketId === 'SETTLED')).toMatchObject({ title: 'A settled prediction', status: 'closed', realized: 2, traded: 5, fees: 0.2 })
    expect(history.bets.find(row => row.marketId === 'UNKNOWN')).toMatchObject({ realized: null, traded: 5 })
  })

  it('reads US commissions and resolved position results without treating deposits as winnings', async () => {
    const trade = { id: 'T', marketSlug: 'M', qtyDecimal: '10', price: amount('0.5'), createTime: at, isAggressor: true, state: 'TRADE_STATE_NEW',
      aggressorExecution: { lastPx: amount('0.5'), commissionNotionalCollected: amount('0.2'), order: { intent: 'ORDER_INTENT_BUY_LONG' } } }
    const history = await polymarketUsHistory(async path => path.includes('/activities') ? { activities: [
      { type: 'ACTIVITY_TYPE_TRADE', trade },
      { type: 'ACTIVITY_TYPE_TRADE', trade },
      { type: 'ACTIVITY_TYPE_TRADE', trade: { ...trade, id: 'BUSTED', state: 'TRADE_STATE_BUSTED' } },
      { type: 'ACTIVITY_TYPE_ACCOUNT_DEPOSIT', accountBalanceChange: { amount: amount('1000') } },
      { type: 'ACTIVITY_TYPE_POSITION_RESOLUTION', positionResolution: { marketSlug: 'M', updateTime: '2026-09-02T00:00:00Z',
        beforePosition: { netPositionDecimal: '10', baseCost: amount('5'), cost: amount('5.2'), fees: amount('0.2'), realized: amount('0') },
        afterPosition: { netPositionDecimal: '0', realized: amount('5'), updateTime: '2026-09-02T00:00:00Z' },
        comboLegDetails: [{ title: 'Game A', outcome: 'Home' }, { title: 'Game B', outcome: 'Away' }],
      } },
    ], eof: true } : { positions: {}, eof: true })
    expect(history.bets).toHaveLength(1)
    expect(history.bets[0]).toMatchObject({ traded: 5, fees: 0.2, realized: 5, status: 'closed' })
    expect(history.bets[0]?.title).toContain('2-leg combo')
    expect(history.activity).toHaveLength(3)
    expect(history.activity.find(row => row.kind === 'settlement')?.amount).toBe(10)
    expect(history.activity.find(row => row.voided)?.id).toBe('trade:BUSTED')
  })

  it('keeps a missing realized result unknown', async () => {
    const history = await polymarketUsHistory(async path => path.includes('/activities') ? { activities: [{ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'T', marketSlug: 'M', qtyDecimal: '2', price: amount('0.4'), createTime: at } }], eof: true } : { positions: {}, eof: true })
    expect(history.bets[0]).toMatchObject({ realized: null, fees: null })
  })

  it('keeps short outcome prices complementary to the long book', async () => {
    const history = await polymarketUsHistory(async path => path.includes('/activities') ? { activities: [{ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'T', marketSlug: 'M', qtyDecimal: '2', price: amount('0.4'), createTime: at, isAggressor: true, aggressorExecution: { order: { intent: 'ORDER_INTENT_BUY_SHORT' }, commissionNotionalCollected: amount('0') } } }], eof: true } : { positions: {}, eof: true })
    expect(history.activity[0]).toMatchObject({ side: 'no', amount: 1.2, kind: 'buy' })
  })

  it('deduplicates international fills before totals and preserves unknown market results', async () => {
    const trade = { type: 'TRADE', transactionHash: 'TX', asset: 'A', side: 'BUY', size: 10, usdcSize: 4, timestamp: 1700000000 }
    const history = await polymarketHistory('wallet', 'https://history.example', (async (url: string) => Response.json(
      url.includes('/closed-positions') ? [{ asset: 'A', realizedPnl: 6, timestamp: 1700000001 }]
        : url.includes('/positions') ? [] : [trade, trade, { ...trade, asset: 'B' }],
    )) as typeof fetch)
    expect(history.activity).toHaveLength(2)
    expect(history.bets.find(row => row.marketId === 'A')).toMatchObject({ traded: 4, realized: 6, fees: null, status: 'closed' })
    expect(history.bets.find(row => row.marketId === 'B')).toMatchObject({ traded: 4, realized: null })
  })
})

describe('history statistics', () => {
  it('separates profits, losses, fees, unknown results, and break-even markets', () => {
    const stats = historyStats([bet(), bet({ realized: -4, fees: 0.1 }), bet({ realized: 0, fees: 0 }), bet({ status: 'open', realized: 0, fees: 0.3 }), bet({ realized: null, fees: null })])
    expect(stats).toMatchObject({ traded: 25, realized: -1.6, won: 2.8, lost: 4.4, wins: 1, losses: 1, breakeven: 1, winRate: 0.5, unknownResults: 1, unknownFees: 1, best: 2.8, worst: -4.1 })
    expect(historyStats([]).winRate).toBeNull()
    expect(historyStats([bet({ realized: null })]).realized).toBeNull()
  })
})

let sqlite: Sqlite
let db: Database
beforeEach(() => {
  sqlite = new Sqlite(':memory:')
  sqlite.exec(`CREATE TABLE exchange_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, venue TEXT, label TEXT, status TEXT, credentials TEXT);
    INSERT INTO exchange_accounts VALUES (1,1,'kalshi','Main','active','sealed'), (2,2,'kalshi','Private','active','other');
    CREATE TABLE trading_strategies (id INTEGER PRIMARY KEY, user_id INTEGER, mode TEXT, name TEXT);
    INSERT INTO trading_strategies VALUES (1,1,'live','Live'), (2,1,'paper','Paper'), (3,2,'paper','Private');
    CREATE TABLE prediction_markets (id INTEGER PRIMARY KEY, venue TEXT, external_id TEXT, question TEXT);
    INSERT INTO prediction_markets VALUES (1,'kalshi','M','Will it happen?');
    CREATE TABLE exchange_positions (id INTEGER PRIMARY KEY, trading_strategy_id INTEGER, exchange_account_id INTEGER, prediction_market_id INTEGER, market_external_id TEXT, venue TEXT, side TEXT, status TEXT, size REAL, cost_basis REAL, realized_pnl REAL, settlement_price REAL, opened_at TEXT, settled_at TEXT);
    INSERT INTO exchange_positions VALUES (1,1,1,1,'M','kalshi','yes','settled',10,5,3,0.8,'2026-09-01','2026-09-02'), (2,2,NULL,1,'M','kalshi','yes','settled',10,5,-5,0,'2026-09-01','2026-09-02'), (3,3,NULL,1,'SECRET','kalshi','yes','settled',10,5,100,1,'2026-09-01','2026-09-02');`)
  for (const path of migrationsFor(['exchange_histories'])) sqlite.exec(readFileSync(path, 'utf8'))
  const executor = {
    unsafe(sql: string, values: unknown[] = []) { return { async execute() { const statement = sqlite.prepare(sql); return sql.trim().startsWith('SELECT') ? statement.all(...values as never[]) : statement.run(...values as never[]) } } },
    async insertOrIgnore(table: string, values: Record<string, unknown>) { sqlite.prepare(`INSERT OR IGNORE INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values) as never[]) },
  }
  db = new Database(executor)
})
afterEach(() => sqlite.close())

it('stores complete imports, rate limits refreshes, and preserves them after failure', async () => {
  let calls = 0
  const open = async () => ({ fetchHistory: async () => { calls++; return { bets: [bet()], activity: [], notes: [] } } }) as any
  expect(await syncHistory(db, { userId: 1, now: new Date(at), clientFor: open })).toEqual({ synced: 1, failed: 0 })
  await syncHistory(db, { userId: 1, now: new Date(at), clientFor: open })
  expect(calls).toBe(1)
  const failed = await syncHistory(db, { userId: 1, now: new Date('2026-09-01T13:00:00Z'), clientFor: async () => { throw new Error('secret venue response') } })
  expect(failed.failed).toBe(1)
  const row = sqlite.query('SELECT * FROM exchange_histories WHERE exchange_account_id=1').get() as any
  expect(JSON.parse(row.payload).bets).toHaveLength(1)
  expect(row.synced_at).toBe('2026-09-01 12:00:00')
  expect(row.last_error).not.toContain('secret')
  expect(sqlite.query('SELECT * FROM exchange_histories WHERE exchange_account_id=2').get()).toBeNull()
})

it('scopes all records to the owner and keeps paper separate without double-counting live fills', async () => {
  await syncHistory(db, { userId: 1, now: new Date(at), clientFor: async () => ({ fetchHistory: async () => ({ bets: [bet()], activity: [], notes: [] }) }) as any })
  const history = await historyForUser(db, 1)
  expect(history.bets).toHaveLength(2)
  expect(history.bets.map(row => row.mode).sort()).toEqual(['live', 'paper'])
  expect(JSON.stringify(history)).not.toContain('SECRET')
  expect(historyStats(history.bets.filter(row => row.mode === 'live')).realized).toBe(2.8)
  expect(historyStats(history.bets.filter(row => row.mode === 'paper')).realized).toBe(-5)
})
