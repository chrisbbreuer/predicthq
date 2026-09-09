import { createHash, randomBytes } from 'node:crypto'
import { Database } from '../Support/db'

export class GroupError extends Error {
  constructor(message: string, readonly status = 422) { super(message) }
}

export interface GroupRow {
  id: number
  name: string
  description: string
  owner_id: number
  role: string
  member_count: number
}

export function positiveId(value: unknown): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new GroupError('Invalid identifier.')
  return id
}

export class Groups {
  constructor(private readonly db = new Database()) {}

  async list(userId: number): Promise<GroupRow[]> {
    return await this.db.query<GroupRow>(`SELECT g.*, m.role,
      (SELECT COUNT(*) FROM group_members c WHERE c.group_id = g.id) AS member_count
      FROM prediction_groups g JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ? ORDER BY g.created_at DESC, g.id DESC LIMIT 100`).all(userId)
  }

  async member(groupId: number, userId: number, ownerOnly = false): Promise<void> {
    const member = await this.db.query<{ role: string }>('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId)
    if (!member) throw new GroupError('Group not found.', 404)
    if (ownerOnly && member.role !== 'owner') throw new GroupError('Only the group owner can manage invitations and members.', 403)
  }

  async create(userId: number, input: { name: string, description: string }): Promise<GroupRow> {
    const name = input.name.trim()
    const description = input.description.trim()
    if (name.length < 2 || name.length > 80 || description.length > 500)
      throw new GroupError('Use a name of 2 to 80 characters and a description up to 500 characters.')
    return await this.db.transaction(async (tx) => {
      const created = await tx.prepare('INSERT INTO prediction_groups (owner_id, name, description) VALUES (?, ?, ?)').run(userId, name, description)
      const id = positiveId(created.lastInsertRowid)
      await tx.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(id, userId, 'owner')
      return { id, owner_id: userId, name, description, role: 'owner', member_count: 1 }
    })
  }

  async details(groupId: number, userId: number) {
    await this.member(groupId, userId)
    const group = await this.db.query<GroupRow>('SELECT * FROM prediction_groups WHERE id = ?').get(groupId)
    if (!group) throw new GroupError('Group not found.', 404)
    const members = await this.db.query<{ user_id: number, name: string, role: string }>(
      'SELECT m.user_id, u.name, m.role FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.id LIMIT 200',
    ).all(groupId)
    const invitations = Number(group.owner_id) === userId
      ? await this.db.query<{ id: number, email: string, expires_at: string, accepted_at: string | null, revoked_at: string | null }>(
        'SELECT id, email, expires_at, accepted_at, revoked_at FROM group_invitations WHERE group_id = ? ORDER BY id DESC LIMIT 100',
      ).all(groupId)
      : []
    return { group, members, invitations, isOwner: Number(group.owner_id) === userId, userId }
  }

  async invite(groupId: number, userId: number, inputEmail: string) {
    await this.member(groupId, userId, true)
    const email = inputEmail.trim().toLowerCase()
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      throw new GroupError('Enter a valid email address or leave it blank for a share link.')
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
    const created = await this.db.prepare(
      'INSERT INTO group_invitations (group_id, invited_by, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(groupId, userId, email, hash(token), expiresAt)
    return { id: created.lastInsertRowid, path: `/groups?invite=${token}`, expiresAt }
  }

  async accept(userId: number, token: string): Promise<{ groupId: number }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new GroupError('This invitation is invalid or no longer available.', 410)
    return await this.db.transaction(async (tx) => {
      const invite = await tx.query<{ id: number, group_id: number, email: string }>(
        'SELECT id, group_id, email FROM group_invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
      ).get(hash(token), new Date().toISOString())
      if (!invite) throw new GroupError('This invitation is invalid or no longer available.', 410)
      const user = await tx.query<{ email: string }>('SELECT email FROM users WHERE id = ?').get(userId)
      if (!user || (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()))
        throw new GroupError('Sign in with the email address this invitation was created for.', 403)
      const claimed = await tx.prepare('UPDATE group_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .run(new Date().toISOString(), invite.id, new Date().toISOString())
      if (claimed.changes !== 1) throw new GroupError('This invitation is no longer available.', 410)
      const member = await tx.query('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').get(invite.group_id, userId)
      if (!member) await tx.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(invite.group_id, userId, 'member')
      return { groupId: Number(invite.group_id) }
    })
  }

  async revoke(groupId: number, userId: number, invitationId: number): Promise<void> {
    await this.member(groupId, userId, true)
    const result = await this.db.prepare('UPDATE group_invitations SET revoked_at = ? WHERE id = ? AND group_id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
      .run(new Date().toISOString(), invitationId, groupId)
    if (!result.changes) throw new GroupError('Active invitation not found.', 404)
  }

  async remove(groupId: number, userId: number, targetId: number): Promise<void> {
    await this.member(groupId, userId, userId !== targetId)
    const target = await this.db.query<{ role: string }>('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, targetId)
    if (!target) throw new GroupError('Member not found.', 404)
    if (target.role === 'owner') throw new GroupError('The owner must stay in the group.', 409)
    await this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND role = ?').run(groupId, targetId, 'member')
  }
}

function hash(token: string): string { return createHash('sha256').update(token).digest('hex') }
