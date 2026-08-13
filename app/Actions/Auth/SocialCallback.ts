import { Database } from '../../Support/db'
import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { response } from '@stacksjs/router'
import { socialProvider } from '../../Support/auth'

/**
 * GET or POST /auth/{provider}/callback - finish an OAuth sign-in.
 *
 * Both methods, because Apple mandates `response_mode=form_post` whenever
 * scopes are requested, so its callback arrives as a cross-site POST while
 * everyone else redirects with a GET. `request.get()` reads query string
 * and form body alike, so the body of this action does not care which one
 * it was handed.
 *
 * Matching is by email, deliberately. Someone who signed up with a
 * password and later clicks "Continue with Google" is the same person, and
 * creating a second account for them is how you end up with two histories
 * and no way to merge them.
 *
 * The provider is the one attesting to the email, so it is trusted here.
 * That trust is the reason `socialProvider` refuses to build an
 * unconfigured provider: an attacker-supplied provider name must never
 * reach this.
 */

/**
 * Apple's one and only chance to tell us a name.
 *
 * It is never in the id_token, so `SocialUser.name` from that driver is
 * always empty. It arrives once, on the first authorisation only, as a
 * JSON `user` field in the form_post body. Miss it and the name is gone
 * for good, which is why it is read here rather than left to the driver.
 */
function nameFromCallbackBody(request: any): string {
  const raw = request.get('user')
  if (!raw)
    return ''

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const first = String(parsed?.name?.firstName ?? '').trim()
    const last = String(parsed?.name?.lastName ?? '').trim()
    return [first, last].filter(Boolean).join(' ')
  }
  catch {
    // A malformed body is not worth failing a sign-in over. The email
    // local-part fallback below is a perfectly good display name.
    return ''
  }
}

export default new Action({
  name: 'SocialCallback',
  description: 'Exchange an OAuth code for a session.',

  async handle(request: any) {
    const name = String(request.getParam('provider') ?? '').toLowerCase()
    const provider = socialProvider(name)

    if (!provider)
      return response.json({ message: 'Unknown sign-in provider.' }, 404)

    const code = String(request.get('code') ?? '')
    if (!code) {
      // The user declined at the provider, or the request was tampered
      // with. Either way there is nothing to exchange.
      return response.redirect('/login?error=cancelled', 302)
    }

    let profile: any
    try {
      const token = await provider.getAccessToken(code)
      profile = await provider.getUserByToken(token)
    }
    catch {
      return response.redirect('/login?error=provider', 302)
    }

    const email = String(profile?.email ?? '').trim().toLowerCase()
    if (!email) {
      // Apple lets the user hide their address behind a relay, and only
      // releases it on the FIRST authorisation. Without one there is no safe
      // key to match on, so we say so rather than inventing one.
      return response.redirect('/login?error=noemail', 302)
    }

    const displayName = String(
      profile?.name || profile?.nickname || nameFromCallbackBody(request) || email.split('@')[0],
    ).slice(0, 60)
    const db = new Database()

    try {
      const existing = await db.prepare<{ id: number }>('SELECT id FROM users WHERE lower(email) = ?').get(email)
      const now = new Date().toISOString()
      let userId = existing?.id ?? 0

      if (!existing) {
        // No password is set. This account can only be reached through the
        // provider until the user chooses one, which is the correct state
        // rather than a placeholder hash somebody could guess.
        const created = await db.prepare(
          `INSERT INTO users (name, email, password, created_at, updated_at)
          VALUES (?, ?, '', ?, ?)`,
        ).run(displayName, email, now, now)
        userId = Number(created.lastInsertRowid)
      }

      // Creating or matching a user is only half a sign-in. Mint the same
      // token pack as password authentication and keep the access token in a
      // secure ambient cookie so the redirected browser is authenticated on
      // its very next request. Without this, OAuth appeared to succeed but
      // every auth-gated page immediately returned 401.
      const login = await Auth.loginUsingId(userId)
      if (!login)
        return response.redirect('/login?error=provider', 302)

      const redirect = response.redirect('/scores/nfl/today', 302)
      const headers = new Headers(redirect.headers)
      headers.append('Set-Cookie', accessTokenCookie(login.token, login.expiresIn))

      return new Response(redirect.body, {
        status: redirect.status,
        statusText: redirect.statusText,
        headers,
      })
    }
    finally {
      db.close()
    }
  },
})

/** Cookie contract consumed by the framework Auth middleware. */
export function accessTokenCookie(token: string, expiresIn: number): string {
  const name = config.auth?.defaultTokenName || 'auth-token'
  const maxAge = Math.max(1, Math.floor(Number(expiresIn) || 1))
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}
