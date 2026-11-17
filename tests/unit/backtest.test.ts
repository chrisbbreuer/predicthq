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
