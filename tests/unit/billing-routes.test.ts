import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import SubscriptionWebhook from '../../app/Actions/Billing/SubscriptionWebhook'

describe('Stripe webhook routing', () => {
  it('bypasses browser CSRF while retaining action-level intent', () => {
    const routes = readFileSync(new URL('../../routes/billing.ts', import.meta.url), 'utf8')

    expect(routes).toContain("route.post('/billing/webhook', 'Actions/Billing/SubscriptionWebhook').skipCsrf()")
    expect(SubscriptionWebhook.skipCsrf).toBeTrue()
  })
})
