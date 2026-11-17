import { describe, expect, it } from 'bun:test'
import { mainLine } from '../../app/Services/scores/game-board'

/**
 * The card shows one spread and one total: the line priced closest to
 * even, from the most preferred book quoting it. Rows below are the shape
 * of Polymarket's ladder for Notre Dame at Florida on 17 Nov 2026.
 */
const row = (book: string, line: number, side: string, price: number) =>
  ({ book, market_type: 'spreads', line, side, point: side === 'home' ? line : -line, price, updated_at: null })

describe('mainLine', () => {
  it('picks the line whose sides are closest to even', () => {
    const picked = mainLine([
      row('polymarket', -11.5, 'home', 1.43), row('polymarket', -11.5, 'away', 2.56),
      row('polymarket', -14.5, 'home', 1.93), row('polymarket', -14.5, 'away', 1.95),
      row('polymarket', -15.5, 'home', 2.2), row('polymarket', -15.5, 'away', 1.72),
    ], ['away', 'home'])
    expect(picked?.get('home')).toEqual({ price: 1.93, book: 'polymarket', point: -14.5 })
    expect(picked?.get('away')?.point).toBe(14.5)
  })

  it('prefers the more trusted book over a slightly more even line', () => {
    const picked = mainLine([
      row('draftkings', -14.5, 'home', 1.91), row('draftkings', -14.5, 'away', 1.91),
      row('polymarket', -14.5, 'home', 1.9), row('polymarket', -14.5, 'away', 1.96),
    ], ['away', 'home'])
    expect(picked?.get('home')?.book).toBe('polymarket')
  })

  it('ignores a line missing one side', () => {
    expect(mainLine([row('polymarket', -14.5, 'home', 1.9)], ['away', 'home'])).toBeNull()
  })
})
