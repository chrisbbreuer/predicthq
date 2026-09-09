import { groupAction } from './group-action'
import { requestString } from '../../Support/request-input'

export default groupAction('CreateGroup', 'POST', async (groups, userId, request) => {
  return await groups.create(userId, { name: requestString(request, 'name'), description: requestString(request, 'description') })
})
