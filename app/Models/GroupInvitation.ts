import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'GroupInvitation', table: 'group_invitations',
  traits: { useTimestamps: true },
  indexes: [{ name: 'group_invitations_group', columns: ['group_id'] }],
  attributes: {
    groupId: { required: true, foreignKey: false, validation: { rule: schema.number().integer().min(1) } },
    invitedBy: { required: true, validation: { rule: schema.number().integer().min(1) } },
    email: { default: '', validation: { rule: schema.string().max(254) } },
    tokenHash: { required: true, unique: true, hidden: true, validation: { rule: schema.string().max(64) } },
    expiresAt: { required: true, validation: { rule: schema.date() } },
    acceptedAt: { nullable: true, validation: { rule: schema.date() } },
    revokedAt: { nullable: true, validation: { rule: schema.date() } },
  },
} as const)
