import { afterAll, describe, expect, it, mock } from 'bun:test'

/**
 * Starting a subscription checkout. The webhook attributes the subscription to
 * its user by `metadata.user_id` on the SUBSCRIPTION, so the checkout must ask
 * for it to be carried there; the payment driver copies a checkout's metadata
 * onto the subscription it creates. This used to be Stripe's own
 * `subscription_data.metadata`, passed through the old Stripe-shaped
 * `user.checkout(items, options)`, which the framework replaced.
 */

// Only the price lookup reaches Stripe; everything else stays real. Restored
// afterwards, since a module mock outlives the file that set it.
const realPayments = await import('@stacksjs/payments')
const listed: unknown[] = []
mock.module('@stacksjs/payments', () => ({
  ...realPayments,
  stripe: {
    prices: {
      list: async (params: unknown) => {
        listed.push(params)
        return { data: [{ id: 'price_signal_monthly' }] }
      },
    },
  },
}))
afterAll(() => {
  mock.module('@stacksjs/payments', () => realPayments)
})

const { default: CreateSubscriptionCheckout } = await import('../../app/Actions/Billing/CreateSubscriptionCheckout')

function request(plan: string | undefined, checkout: (request: unknown) => Promise<unknown>) {
  return {
    get: (key: string) => (key === 'plan' ? plan : undefined),
    user: async () => ({ id: 42, checkout }),
  }
}

describe('CreateSubscriptionCheckout', () => {
  it('checks out the plan\'s price, carrying the user onto the subscription', async () => {
    const requests: any[] = []
    const result = await CreateSubscriptionCheckout.handle(request('predicthq_signal_monthly', async (checkout) => {
      requests.push(checkout)
      return { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', expiresAt: null, raw: {} }
    }))

    expect(result).toMatchObject({ url: 'https://checkout.stripe.com/c/cs_1', plan: 'predicthq_signal_monthly' })
    expect(listed).toEqual([{ lookup_keys: ['predicthq_signal_monthly'], active: true, limit: 1 }])

    expect(requests).toHaveLength(1)
    const checkout = requests[0]
    expect(checkout).toMatchObject({
      mode: 'subscription',
      lines: [{ price: 'price_signal_monthly', quantity: 1 }],
      allowPromotionCodes: true,
      metadata: { user_id: '42' },
    })
    expect(checkout.successUrl).toEndWith('/billing/welcome?session={CHECKOUT_SESSION_ID}')
    expect(checkout.cancelUrl).toEndWith('/pricing')
  })

  it('refuses a plan key it does not publish, before reaching Stripe', async () => {
    let called = false
    const result = await CreateSubscriptionCheckout.handle(request('free_forever', async () => {
      called = true
      return {}
    }))
    expect(called).toBe(false)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(422)
  })
})
