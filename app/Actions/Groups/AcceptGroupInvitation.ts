import { groupAction } from './group-action'
import { requestString } from '../../Support/request-input'

export default groupAction('AcceptGroupInvitation', 'POST', async (groups, userId, request) => {
  return await groups.accept(userId, requestString(request, 'token'))
})
