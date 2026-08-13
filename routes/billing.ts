import { route } from '@stacksjs/router'

/**
 * Billing routes, served under `/api`.
 *
 * The webhook is deliberately outside the auth group: Stripe cannot
 * present a session, and its identity is proved by the signature over
 * the raw body instead. That check happens inside the action, before
 * anything from the payload is read.
 *
 * The framework already serves the rest of the Stripe surface — payment
 * methods, invoices, cancellation — under `/payments/*` with auth. These
 * two are the PredictHQ-specific halves: starting a subscription on one
 * of our plans, and keeping the subscriptions table honest so
 * `entitlements.ts` can read it instead of calling Stripe on every
 * trading pass.
 */

route.post('/billing/webhook', 'Actions/Billing/SubscriptionWebhook').skipCsrf()

// Each checkout call creates a session at Stripe, so an unthrottled loop
// here is an unthrottled loop against our payment provider.
route.group({ middleware: ['auth', 'throttle:10,1'] }, () => {
  route.post('/billing/checkout', 'Actions/Billing/CreateSubscriptionCheckout')
})
