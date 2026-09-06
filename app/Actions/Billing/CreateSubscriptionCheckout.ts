import { config } from '@stacksjs/config'
import { response } from '@stacksjs/router'
import { plans } from '../../../config/saas'
import { tierFrom } from '../../Services/billing/entitlements'

/**
 * POST /api/billing/checkout — start a PredictHQ subscription.
 *
 * The caller names a plan key from config/saas.ts, never a Stripe price
 * id. That indirection is the point: a request that could name its own
 * price could name a $0 one, and the tier a user ends up on is decided
 * here from our own config rather than from anything they sent.
 *
 * `subscription_data.metadata.user_id` is what the webhook attributes
 * the subscription by. Without it the webhook falls back to a customer
 * lookup, which works but breaks for anyone whose Stripe customer was
 * created outside this flow — so it is set at the one moment we
 * certainly know who is subscribing.
 */
export default {
  name: 'CreateSubscriptionCheckout',
  description: 'Create a Stripe Checkout session for a PredictHQ plan.',

  async handle(request?: {
    get?: (key: string) => string | undefined
    user?: () => Promise<UserLike | null>
  }) {
    const user = await request?.user?.()
    if (!user)
      return response.error('Sign in to subscribe.', 401)

    const planKey = request?.get?.('plan') ?? ''
    if (!planKey)
      return response.error('A plan key is required.', 422)

    if (!isConfiguredPlan(planKey))
      return response.error(`Unknown plan: ${planKey}.`, 422)

    // A key that maps to no tier would create a subscription the
    // entitlement layer cannot read — a paying customer with nothing
    // unlocked. Fail here instead.
    if (tierFrom(planKey) === 'none')
      return response.error(`Plan ${planKey} does not map to a PredictHQ tier.`, 422)

    const priceId = await resolvePriceId(planKey)
    if (!priceId) {
      return response.error(
        `Plan ${planKey} is configured but has no active price in Stripe. Run \`buddy setup:products\`.`,
        503,
      )
    }

    const appUrl = normalizeUrl(config.app.url)

    try {
      const checkout = await user.checkout(
        [{ priceId, quantity: 1 }],
        {
          mode: 'subscription',
          allowPromotions: true,
          success_url: `${appUrl}/billing/welcome?session={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/pricing`,
          subscription_data: {
            metadata: { user_id: String(user.id) },
          },
        },
      )

      return { url: checkout.url, plan: planKey, tier: tierFrom(planKey) }
    }
    catch (error) {
      return response.error(
        `Could not start checkout: ${error instanceof Error ? error.message : String(error)}`,
        502,
      )
    }
  },
}

interface UserLike {
  id: number
  checkout: (
    items: Array<{ priceId: string, quantity: number }>,
    options: Record<string, unknown>,
  ) => Promise<{ url: string | null }>
}

/** Is this a plan key we actually publish? */
function isConfiguredPlan(planKey: string): boolean {
  return plans.some(
    plan => (plan.pricing ?? []).some(pricing => pricing.key === planKey),
  )
}

/**
 * The Stripe price id behind a plan key.
 *
 * `buddy setup:products` creates each price with our key as its
 * `lookup_key` and lets Stripe mint the `price_…` id, so the key is the
 * stable identifier on our side and the lookup is what bridges the two.
 * That avoids a mapping table of Stripe ids in config, which is the
 * thing that silently rots when prices are recreated.
 *
 * Cached for the process: the set changes only when prices are, and a
 * Stripe round trip per checkout click is a latency cost with no
 * corresponding freshness benefit.
 */
const priceIdCache = new Map<string, string>()

async function resolvePriceId(planKey: string): Promise<string | null> {
  const cached = priceIdCache.get(planKey)
  if (cached)
    return cached

  const { stripe } = await import('@stacksjs/payments')

  const prices = await stripe.prices.list({
    lookup_keys: [planKey],
    active: true,
    limit: 1,
  })

  const priceId = prices.data[0]?.id
  if (!priceId)
    return null

  priceIdCache.set(planKey, priceId)
  return priceId
}

/** config.app.url may omit the scheme; Stripe requires an absolute URL. */
function normalizeUrl(url: string): string {
  const absolute = url.startsWith('http') ? url : `https://${url}`
  return absolute.replace(/\/$/, '')
}
