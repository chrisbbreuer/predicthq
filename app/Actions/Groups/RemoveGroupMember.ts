import { groupAction } from './group-action'
import { positiveId } from '../../Services/groups'

export default groupAction('RemoveGroupMember', 'DELETE', async (groups, userId, request) => {
  await groups.remove(positiveId(request.getParam?.('id')), userId, positiveId(request.getParam?.('userId')))
  return { success: true }
})
