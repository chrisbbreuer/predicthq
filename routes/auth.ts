import { route } from '@stacksjs/router'

/**
 * Browser session endpoints.
 *
 * The private pages use the framework auth composable, whose canonical user
 * check is `/api/me`. Refresh lives beside the rest of this route file so it
 * reaches the API service as well; the public document server owns unknown
 * root paths and would otherwise answer `/auth/refresh` itself.
 */
route.get('/me', 'Actions/Auth/AuthUserAction').middleware('auth')
route.post('/auth/refresh', 'Actions/Auth/RefreshTokenAction').rateLimit(10, 'minute')

/**
 * Social sign-in. Served under /api.
 *
 * The stx page server owns the document root and answers any unknown root
 * path with its own 404, so these never reached the API router when they
 * were registered at `/auth/...`. Providers accept whatever callback URL
 * is registered with them, so the prefix is free.
 */
route.get('/auth/{provider}/redirect', 'Actions/Auth/SocialRedirect')
route.get('/auth/{provider}/callback', 'Actions/Auth/SocialCallback')

/**
 * The same callback again, for POST.
 *
 * Apple mandates `response_mode=form_post` whenever scopes are requested,
 * and name plus email are requested by default, so its callback arrives as
 * a cross-site POST rather than a redirect. With only the GET registered
 * above, every completed Apple sign-in landed on a 404 and the visitor was
 * told the page did not exist.
 *
 * Registered for all providers rather than Apple alone: the action reads
 * query string and form body through the same accessor, so the extra
 * method costs nothing and is one less thing to remember when the next
 * form_post provider is added.
 *
 * `skipCsrf` because the request originates at Apple, which has no way to
 * carry our token and would be rejected on arrival. An OAuth callback does
 * not rest on CSRF anyway: what authenticates it is the `state` parameter
 * and the fact that the code is worthless until exchanged with the
 * provider over TLS using our own signing key.
 */
route.post('/auth/{provider}/callback', 'Actions/Auth/SocialCallback').skipCsrf()
