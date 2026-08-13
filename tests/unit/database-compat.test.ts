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
})
