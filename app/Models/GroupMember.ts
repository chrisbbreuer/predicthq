import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'GroupMember', table: 'group_members',
  traits: { useTimestamps: true },
  indexes: [{ name: 'group_members_group_user_unique', columns: ['group_id', 'user_id'], unique: true }],
  attributes: {
    groupId: { required: true, foreignKey: false, validation: { rule: schema.number().integer().min(1) } },
    userId: { required: true, validation: { rule: schema.number().integer().min(1) } },
    role: { required: true, default: 'member', validation: { rule: schema.enum(['owner', 'member']) } },
  },
} as const)
