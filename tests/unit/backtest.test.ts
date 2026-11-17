import { describe, expect, it } from 'bun:test'
import { kalshiFee, settleBet } from '../../app/Services/trading/backtest'

describe('backtest settlement', () => {
  it('charges the taker fee rounded up to the cent', () => {
    // 0.07 * 10 * 0.5 * 0.5 = 0.175 -> 0.18
    expect(kalshiFee(10, 0.5)).toBe(0.18)
    // 0.07 * 1 * 0.9 * 0.1 = 0.0063 -> 0.01
    expect(kalshiFee(1, 0.9)).toBe(0.01)
  })

  it('pays a dollar a contract on a win, net of stake and fee', () => {
    // $1 at 0.50 buys 2 contracts: +$1 gross, fee ceil(0.035) = 0.04
    expect(settleBet(1, 0.5, true)).toEqual({ fee: 0.04, pnl: 0.96 })
  })

  it('loses the stake and the fee on a miss', () => {
    expect(settleBet(1, 0.5, false)).toEqual({ fee: 0.04, pnl: -1.04 })
  })
})

describe('backtest tape', () => {
  it('answers window queries the way the app binds timestamps', async () => {
    const { tapeDatabase } = await import('../../app/Services/trading/backtest')
    const tape = tapeDatabase(7, [
      { id: 'a', side: 'yes', price: 0.4, size: 10, at: '2026-11-16T23:00:00.123456Z' },
      { id: 'b', side: 'no', price: 0.6, size: 5, at: '2026-11-17T01:00:00Z' },
    ])
    const row = await tape.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM market_trades WHERE prediction_market_id = ? AND traded_at >= ? AND traded_at < ?')
      .get(7, '2026-11-16T22:00:00.000Z', '2026-11-17T00:30:00.000Z')
    expect(Number(row?.n)).toBe(1)
    tape.close()
  })
})
