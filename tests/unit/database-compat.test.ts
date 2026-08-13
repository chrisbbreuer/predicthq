import { describe, expect, it } from 'bun:test'
import { Database, databaseValue } from '../../app/Support/db'

describe('database compatibility', () => {
  it('translates RFC 3339 UTC timestamps to portable SQL datetimes', () => {
    expect(databaseValue('2026-08-13T18:40:00.010Z')).toBe('2026-08-13 18:40:00')
    expect(databaseValue('ordinary value')).toBe('ordinary value')
  })

  it('normalizes every raw statement parameter at the driver boundary', async () => {
    let received: unknown[] = []
    const executor = {
      unsafe: (_sql: string, parameters: unknown[] = []) => ({
        execute: async () => {
          received = parameters
          return { affectedRows: 1 }
        },
      }),
    }

    await new Database(executor as any)
      .prepare('UPDATE sports SET updated_at = ? WHERE slug = ?')
      .run('2026-08-13T18:40:00.010Z', 'nfl')

    expect(received).toEqual(['2026-08-13 18:40:00', 'nfl'])
  })

  it('normalizes records sent through Stacks insert and upsert helpers', async () => {
    let inserted: Record<string, unknown> = {}
    let upserted: Record<string, unknown>[] = []
    const executor = {
      insertOrIgnore: async (_table: string, values: Record<string, unknown>) => {
        inserted = values
      },
      upsert: async (_table: string, rows: Record<string, unknown>[]) => {
        upserted = rows
        return { affectedRows: rows.length }
      },
      unsafe: () => ({ execute: async () => ({}) }),
    }
    const db = new Database(executor as any)

    await db.insertOrIgnore('event_sources', { provider: 'espn', updated_at: '2026-08-13T19:00:14.586Z' })
    await db.upsert('odds', [{ external_id: 'price-1', updated_at: '2026-08-13T19:00:14.586Z' }], ['external_id'])

    expect(inserted.updated_at).toBe('2026-08-13 19:00:14')
    expect(upserted[0]?.updated_at).toBe('2026-08-13 19:00:14')
  })
})
