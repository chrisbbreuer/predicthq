import { describe, expect, it } from 'bun:test'
import { accessTokenCookie } from '../../app/Actions/Auth/SocialCallback'

describe('social authentication cookie', () => {
  it('uses the auth middleware cookie name and secure browser flags', () => {
    const cookie = accessTokenCookie('token with spaces', 900.9)

    expect(cookie).toContain('auth-token=token%20with%20spaces')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=900')
  })
})
