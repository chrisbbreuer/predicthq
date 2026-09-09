import { groupAction } from './group-action'
import { positiveId } from '../../Services/groups'

export default groupAction('GetGroup', 'GET', async (groups, userId, request) => {
  return await groups.details(positiveId(request.getParam?.('id')), userId)
})
