import { config } from '@stacksjs/config'
import { AppleProvider, GoogleProvider } from '@stacksjs/socials'

/**
 * Which sign-in providers are usable right now, and how to build them.
 *
 * Providers do not share a config shape. Google is the OAuth2 norm
 * (clientId + clientSecret), while Apple has no static client secret at
 * all: its driver signs a short-lived ES256 JWT from teamId + keyId +
 * privateKey. A single `clientId && clientSecret` check therefore reads a
 * fully configured Apple as absent, which is exactly what used to happen,
 * and Sign in with Apple could never appear no matter what was in
 * `config/services.ts`.
 *
 * Adding credentials is the whole of what turns a provider on. Nothing
 * here needs changing to enable one.
 *
 * This mirrors `configuredSocialProviders()` / `socialProvider()`, which
 * now ship in @stacksjs/socials. Swap to those imports once a release
 * carrying them lands; the shapes are deliberately identical.
 */

export interface SocialProvider {
  /** Path segment `/api/auth/{slug}/redirect` is built from. */
  slug: string
  /** Display name, as the provider's own brand guidelines write it. */
  name: string
  /**
   * Iconify class for the provider mark. f7 rather than the hugeicons the
   * rest of the app uses: these are brand marks, and hugeicons carries
   * outline approximations of them (its "google" is a circle with a bar)
   * where f7 carries the real silhouettes. A sign-in button is the one
   * place the mark has to be the actual logo.
   */
  icon: string
}

interface ProviderDescriptor extends SocialProvider {
  driver: new (providerConfig: any) => any
  /** `config.services[slug]` keys that must be set before sign-in works. */
  required: string[]
  /**
   * True when the provider posts its callback cross-site rather than
   * redirecting with a GET. Apple mandates `response_mode=form_post`
   * whenever scopes are requested, which is why `routes/auth.ts` registers
   * the callback for both methods.
   */
  postCallback: boolean
}

const PROVIDERS: ProviderDescriptor[] = [
  {
    slug: 'google',
    name: 'Google',
    icon: 'i-f7-logo-google',
    driver: GoogleProvider,
    required: ['clientId', 'clientSecret', 'redirectUrl'],
    postCallback: false,
  },
  {
    slug: 'apple',
    name: 'Apple',
    icon: 'i-f7-logo-apple',
    driver: AppleProvider,
    required: ['clientId', 'teamId', 'keyId', 'privateKey', 'redirectUrl'],
    postCallback: true,
  },
]

function descriptorFor(slug: string): ProviderDescriptor | null {
  return PROVIDERS.find(provider => provider.slug === slug) ?? null
}

function settingsFor(slug: string): Record<string, any> | null {
  return (config as any)?.services?.[slug] ?? null
}

function isConfigured(descriptor: ProviderDescriptor): boolean {
  const settings = settingsFor(descriptor.slug)
  if (!settings)
    return false

  return descriptor.required.every(key => Boolean(settings[key]))
}

/**
 * The providers a visitor can actually complete a sign-in with. Render
 * buttons straight off this and a half-configured provider never reaches
 * anyone as a button that dead-ends at the redirect.
 */
export function configuredSocialProviders(): SocialProvider[] {
  return PROVIDERS
    .filter(isConfigured)
    .map(({ slug, name, icon }) => ({ slug, name, icon }))
}

/**
 * Build a provider, or null when it is not configured.
 *
 * The whole config block is passed through, so Apple's signing fields
 * reach the driver instead of being dropped by a caller that only knew
 * about clientId and clientSecret. Null rather than a throw so a route can
 * answer 404: sending someone to a provider's own error page reads to them
 * as our fault and gives them nothing to act on.
 */
export function socialProvider(slug: unknown): any | null {
  const descriptor = descriptorFor(String(slug ?? '').toLowerCase())
  if (!descriptor || !isConfigured(descriptor))
    return null

  const settings = settingsFor(descriptor.slug) ?? {}

  return new descriptor.driver({
    // Required by ProviderConfig but meaningless to Apple, hence defaulted
    // rather than demanded.
    clientSecret: '',
    ...settings,
    clientId: String(settings.clientId ?? ''),
    redirectUrl: String(settings.redirectUrl ?? ''),
  })
}

/**
 * Messages for the `?error=` codes `Actions/Auth/SocialCallback` redirects
 * back with. Anything unrecognised gets a generic line rather than being
 * echoed to the page.
 */
const ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. Nothing was changed.',
  provider: 'The provider could not confirm that sign-in. Please try again.',
  state: 'That sign-in request expired or could not be verified. Please start again.',
  noemail: 'That provider did not share an email address, so there is no account to match. Try the other provider, or turn off private relay for PredictHQ.',
}

export function signInError(code: unknown): string {
  const key = String(code ?? '')
  if (!key)
    return ''

  return ERRORS[key] ?? 'Sign-in did not complete. Please try again.'
}
