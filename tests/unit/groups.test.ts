import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database as Sqlite } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { Groups } from '../../app/Services/groups'
import { Database } from '../../app/Support/db'
import { migrationsFor } from '../support/schema'

let sqlite: Sqlite
let groups: Groups

beforeEach(() => {
  sqlite = new Sqlite(':memory:')
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT); INSERT INTO users VALUES (1, 'owner@example.com', 'Owner'), (2, 'friend@example.com', 'Friend'), (3, 'other@example.com', 'Other');")
  for (const path of migrationsFor(['prediction_groups', 'group_members', 'group_invitations']))
    sqlite.exec(readFileSync(path, 'utf8'))
  const executor = {
    unsafe(sql: string, values: unknown[] = []) {
      return { async execute() {
        const statement = sqlite.prepare(sql)
        return sql.trim().startsWith('SELECT') ? statement.all(...values as never[]) : statement.run(...values as never[])
      } }
    },
    async transaction<T>(fn: (tx: typeof executor) => Promise<T> | T): Promise<T> {
      sqlite.exec('BEGIN')
      try { const result = await fn(executor); sqlite.exec('COMMIT'); return result }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
  groups = new Groups(new Database(executor))
})
afterEach(() => sqlite.close())

describe('private groups', () => {
  it('creates owner membership atomically and scopes discovery to members', async () => {
    const group = await groups.create(1, { name: 'Sunday crew', description: 'Football' })
    expect((await groups.list(1))[0]?.id).toBe(group.id)
    expect(await groups.list(2)).toEqual([])
    await expect(groups.details(group.id, 2)).rejects.toMatchObject({ status: 404 })
    expect((await groups.details(group.id, 1)).members).toHaveLength(1)
  })

  it('stores only a token hash and accepts an email-bound invitation once', async () => {
    const group = await groups.create(1, { name: 'Sunday crew', description: '' })
    const invitation = await groups.invite(group.id, 1, 'Friend@Example.com')
    const token = invitation.path.split('=')[1]!
    const stored = sqlite.query('SELECT token_hash FROM group_invitations').get() as { token_hash: string }
    expect(stored.token_hash).not.toBe(token)
    await expect(groups.accept(3, token)).rejects.toMatchObject({ status: 403 })
    expect((await groups.accept(2, token)).groupId).toBe(group.id)
    await expect(groups.accept(3, token)).rejects.toMatchObject({ status: 410 })
    expect((await groups.details(group.id, 2)).invitations).toEqual([])
    expect((await groups.list(2))[0]?.member_count).toBe(2)
  })

  it('rejects expired, revoked and malformed links', async () => {
    const group = await groups.create(1, { name: 'Sunday crew', description: '' })
    const expired = await groups.invite(group.id, 1, '')
    sqlite.exec("UPDATE group_invitations SET expires_at = '2000-01-01 00:00:00'")
    await expect(groups.accept(2, expired.path.split('=')[1]!)).rejects.toMatchObject({ status: 410 })
    const revoked = await groups.invite(group.id, 1, '')
    await groups.revoke(group.id, 1, revoked.id)
    await expect(groups.accept(2, revoked.path.split('=')[1]!)).rejects.toMatchObject({ status: 410 })
    await expect(groups.accept(2, 'not-a-token')).rejects.toMatchObject({ status: 410 })
  })

  it('prevents privilege escalation and removing the owner, but allows leaving', async () => {
    const group = await groups.create(1, { name: 'Sunday crew', description: '' })
    const invitation = await groups.invite(group.id, 1, '')
    await groups.accept(2, invitation.path.split('=')[1]!)
    await expect(groups.invite(group.id, 2, '')).rejects.toMatchObject({ status: 403 })
    await expect(groups.remove(group.id, 2, 1)).rejects.toMatchObject({ status: 403 })
    await expect(groups.remove(group.id, 1, 1)).rejects.toMatchObject({ status: 409 })
    await groups.remove(group.id, 2, 2)
    expect(await groups.list(2)).toEqual([])
  })

  it('cannot revoke an invitation belonging to another group', async () => {
    const first = await groups.create(1, { name: 'First group', description: '' })
    const second = await groups.create(3, { name: 'Second group', description: '' })
    const invite = await groups.invite(second.id, 3, '')
    await expect(groups.revoke(first.id, 1, invite.id)).rejects.toMatchObject({ status: 404 })
    expect((await groups.accept(2, invite.path.split('=')[1]!)).groupId).toBe(second.id)
  })
})
