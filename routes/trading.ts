import { route } from '@stacksjs/router'

/**
 * Trading routes, served under `/api`.
 *
 * Two groups, split by what they can cause:
 *
 *   Read — candidates and the decision feed. Nothing is persisted and no
 *          venue is contacted, so these are safe to poll and safe to
 *          show before a user has connected anything.
 *   Write — strategies, venue accounts, and reviews. All authenticated,
 *          all subject to the plan entitlement checked inside the action
 *          rather than at the route, because the answer differs per
 *          field (a Signal user may save a strategy but not arm it).
 *
 * @see app/Services/trading/ for the engine these sit in front of.
 */

// Both are computed live from the tape rather than served from a cache,
// so they are throttled like the other uncached read endpoints — freely
// enough for a page that polls, not freely enough to be a free
// recomputation service.
route.group({ middleware: ['throttle:120,1'] }, () => {
  // What the engine is looking at right now.
  route.get('/trading/candidates', 'Actions/Trading/GetCandidates')
})

/**
 * Writes are throttled per authenticated user on top of the auth check,
 * because authentication says who is asking and nothing about how often.
 * The budgets differ by what a call costs us: saving a strategy is a row,
 * so it is generous; connecting an account is a network round trip to a
 * venue under our credentials, so it is not.
 */
route.group({ middleware: ['auth', 'throttle:60,1'] }, () => {
  route.get('/trading/accounts', 'Actions/Trading/GetExchangeAccounts')
  route.get('/trading/strategies', 'Actions/Trading/GetStrategies')
  route.post('/trading/strategies', 'Actions/Trading/SaveStrategy')

  // Decisions carry user-authored strategy names, sizes, and outcomes.
  // They are private to their owner, even when the underlying market is public.
  route.get('/trading/decisions', 'Actions/Trading/GetDecisions')

  // What the strategies actually returned. Every other endpoint here
  // describes intent; this one describes outcome.
  route.get('/trading/performance', 'Actions/Trading/GetPerformance')

  // Manual approval — the path a strategy left on manual, or a plan
  // without automated execution, queues decisions into.
  route.post('/trading/decisions/{id}/review', 'Actions/Trading/ReviewDecision')
})

// Connecting an account verifies the credentials against the venue before
// storing them, so every call is a request we make to Kalshi or
// Polymarket. Left ungoverned it is an amplifier: one caller's loop
// becomes our IP failing authentication at a venue repeatedly, which is
// how an account gets rate limited or blocked. Nobody connects an account
// five times a minute legitimately.
route.group({ middleware: ['auth', 'throttle:5,1'] }, () => {
  route.post('/trading/accounts', 'Actions/Trading/ConnectExchangeAccount')
  route.delete('/trading/accounts/{venue}', 'Actions/Trading/DisconnectExchangeAccount')
})
