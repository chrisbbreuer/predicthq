import { describe, expect, it } from 'bun:test'
import { accessTokenCookie, exchangeGoogleCode, expiredOauthStateCookie, oauthSuccess } from '../../app/Actions/Auth/SocialCallback'
import { oauthStateCookie } from '../../app/Actions/Auth/SocialRedirect'
import { accessTokenFromRequest } from '../../app/Middleware/Auth'

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

  it('round-trips an encoded access token through the auth middleware', () => {
    const token = '7|session:token/with+punctuation='
    const setCookie = accessTokenCookie(token, 900)
    const cookie = setCookie.split(';', 1)[0]
    const request = new Request('https://predicthq.org/api/positions', {
      headers: { cookie },
    })

    expect(accessTokenFromRequest(request)).toBe(token)
  })

  it('delivers the auth cookie as the only cookie on the success redirect', () => {
    const redirect = oauthSuccess('browser-token', 900)

    expect(redirect.status).toBe(303)
    expect(redirect.headers.get('location')).toBe('/scores/nfl/today')
    expect(redirect.headers.getSetCookie()).toEqual([
      accessTokenCookie('browser-token', 900),
    ])
  })
})

describe('social authentication state', () => {
  it('scopes the short-lived state cookie to the provider callback', () => {
    const cookie = oauthStateCookie('google', 'state with spaces')

    expect(cookie).toContain('oauth-state-google=state%20with%20spaces')
    expect(cookie).toContain('Path=/api/auth/google/callback')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=None')
    expect(cookie).toContain('Max-Age=600')
    expect(expiredOauthStateCookie('google')).toContain('Max-Age=0')
  })
})

describe('Google token exchange', () => {
  it('uses form encoding and the OpenID userinfo endpoint', async () => {
    const calls: Array<{ url: string, init?: RequestInit }> = []
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/token'))
        return Response.json({ access_token: 'access-token' })
      return Response.json({ sub: 'google-id', email: 'person@example.com', name: 'Person' })
    }

    const profile = await exchangeGoogleCode('auth-code', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUrl: 'https://example.com/api/auth/google/callback',
    }, request)

    expect(profile.email).toBe('person@example.com')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(String(calls[0]?.init?.body)).toContain('grant_type=authorization_code')
    expect(calls[1]?.url).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    expect(calls[1]?.init?.headers).toEqual({ Authorization: 'Bearer access-token' })
  })
})
