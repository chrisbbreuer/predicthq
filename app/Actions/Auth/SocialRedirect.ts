import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { socialProvider } from '../../Support/auth'

/**
 * GET /auth/{provider}/redirect - start an OAuth sign-in.
 *
 * The provider is resolved from our own config rather than from the
 * request, so an unconfigured provider is a 404 rather than a redirect to
 * a broken authorize URL. That matters: a half-configured provider
 * otherwise sends the user to the provider's error page, which reads to
 * them as our fault and gives them nothing to act on.
 *
 * `socialProvider` in Support/auth knows what each provider needs and
 * hands the driver its whole config block. This action used to do that
 * itself, gating everything on `clientId && clientSecret` and passing only
 * those two through, which meant Apple (no client secret, signs a JWT from
 * teamId/keyId/privateKey instead) was rejected here even when fully
 * configured.
 */
export default new Action({
  name: 'SocialRedirect',
  description: 'Send the visitor to a social provider to authenticate.',

  async handle(request: any) {
    const name = String(request.getParam('provider') ?? '').toLowerCase()
    const provider = socialProvider(name)

    if (!provider) {
      return response.json({
        message: `${name || 'That provider'} is not configured for sign-in.`,
      }, 404)
    }

    // The state parameter is what ties the callback back to this request;
    // the provider mints and stores it.
    const url = await provider.getAuthUrl()
    const state = new URL(url).searchParams.get('state') ?? ''
    if (!state)
      return response.json({ message: 'The sign-in provider did not create a state token.' }, 500)

    const redirect = response.redirect(url, 302)
    const headers = new Headers(redirect.headers)
    headers.append('Set-Cookie', oauthStateCookie(name, state))

    return new Response(redirect.body, {
      status: redirect.status,
      statusText: redirect.statusText,
      headers,
    })
  },
})

export function oauthStateCookie(provider: string, state: string): string {
  return `oauth-state-${provider}=${encodeURIComponent(state)}; Path=/api/auth/${provider}/callback; HttpOnly; Secure; SameSite=None; Max-Age=600`
}
