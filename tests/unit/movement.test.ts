import { describe, expect, it } from 'bun:test'
import { movementFor } from '../../app/Services/quant/movement'

describe('movement features', () => {
  it('computes finite dispersion when Vitess returns decimals as strings', async () => {
    const db = {
      query: () => ({
        all: async () => [
          { bookmaker_id: 1, price: '1.71', captured_at: '2026-08-13T18:00:00.000Z' },
          { bookmaker_id: 2, price: '1.85', captured_at: '2026-08-13T18:00:00.000Z' },
        ],
      }),
    }

    const movement = await movementFor(db as any, 1707)

    expect(Number.isFinite(movement.priceStdDev)).toBe(true)
    expect(movement.priceStdDev).toBeCloseTo(0.0989949, 6)
  })

  it('drops corrupt quotes instead of leaking NaN into a feature row', async () => {
    const db = {
      query: () => ({
        all: async () => [
          { bookmaker_id: 1, price: 'not-a-price', captured_at: '2026-08-13T18:00:00.000Z' },
        ],
      }),
    }

    const movement = await movementFor(db as any, 1707)

    expect(movement.priceStdDev).toBe(0)
    expect(movement.currentPrice).toBe(0)
  })
})
