import { Auth, requestToken, sessionUser } from '@stacksjs/auth'
import { HttpError } from '@stacksjs/error-handling'
import { Middleware } from '@stacksjs/router'

export function accessTokenFromRequest(request: any): string | null {
  return requestToken(request)
}

async function stampTokenUser(request: any, token: string): Promise<void> {
  const user = await Auth.getUserFromToken(token)
  if (!user)
    throw new HttpError(401, 'Unauthorized. Invalid or expired token.')

  Auth.setUser(user)
  request._authenticatedUser = user
  request._currentAccessToken = await Auth.currentAccessToken()
}

export default new Middleware({
  name: 'Auth',
  priority: 1,

  async handle(request) {
    const token = accessTokenFromRequest(request)
    if (token) {
      await stampTokenUser(request, token)
      return
    }

    const sessionId = request.cookie?.('session_id')
    if (sessionId) {
      const user = await sessionUser(sessionId)
      if (!user)
        throw new HttpError(401, 'Unauthorized. Session expired.')

      Auth.setUser(user)
      request._authenticatedUser = user
      return
    }

    throw new HttpError(401, 'Unauthorized. No token or session provided.')
  },
})
