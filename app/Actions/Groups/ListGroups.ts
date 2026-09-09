import { groupAction } from './group-action'

export default groupAction('ListGroups', 'GET', async (groups, userId) => {
  return await groups.list(userId)
})
