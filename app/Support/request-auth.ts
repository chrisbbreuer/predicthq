interface AuthenticatedUser {
  id?: number | string
}

interface AuthenticatedRequest {
  /** Current Stacks requests expose the authenticated user through this method. */
  user?: AuthenticatedUser | (() => AuthenticatedUser | null | Promise<AuthenticatedUser | null>)
  /** Kept as a fallback for middleware-compatible request implementations. */
  _authenticatedUser?: AuthenticatedUser | null
}

/**
 * Resolve the signed-in user without coupling actions to one router request shape.
 *
 * Stacks previously exposed `request.user` as a value and now exposes `user()`.
 * Calling the method with the request as its receiver matters because the router
 * implementation reads `_authenticatedUser` from `this`.
 */
export async function authenticatedUserId(request?: AuthenticatedRequest): Promise<number | null> {
  const candidate = typeof request?.user === 'function'
    ? await request.user.call(request)
    : request?.user ?? request?._authenticatedUser

  const id = Number(candidate?.id ?? 0)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
