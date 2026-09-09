import { response } from '@stacksjs/router'
import { Groups, GroupError } from '../../Services/groups'
import { authenticatedUserId } from '../../Support/request-auth'

interface GroupRequest {
  get?: (key: string) => unknown
  getParam?: (key: string) => unknown
  user?: { id?: number | string } | (() => Promise<{ id?: number | string } | null>)
}

export function groupAction(name: string, method: string, handle: (groups: Groups, userId: number, request: GroupRequest) => Promise<unknown>) {
  return {
    name, method,
    async handle(request: GroupRequest) {
      const userId = await authenticatedUserId(request)
      if (!userId) return response.error('Sign in to use groups.', 401)
      try {
        return response.json(await handle(new Groups(), userId, request), { headers: { 'Cache-Control': 'private, no-store' } })
      }
      catch (error) {
        if (error instanceof GroupError) return response.error(error.message, error.status)
        return response.error('Could not update groups. Please try again.', 500)
      }
    },
  }
}
