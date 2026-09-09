import { groupAction } from './group-action'
import { positiveId } from '../../Services/groups'

export default groupAction('RevokeGroupInvitation', 'DELETE', async (groups, userId, request) => {
  await groups.revoke(positiveId(request.getParam?.('id')), userId, positiveId(request.getParam?.('invitationId')))
  return { success: true }
})
