import { groupAction } from './group-action'
import { positiveId } from '../../Services/groups'
import { requestString } from '../../Support/request-input'

export default groupAction('InviteToGroup', 'POST', async (groups, userId, request) => {
  return await groups.invite(positiveId(request.getParam?.('id')), userId, requestString(request, 'email'))
})
