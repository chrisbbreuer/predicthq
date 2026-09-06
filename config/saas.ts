import type { SaasConfig } from '@stacksjs/types'

/**
 * **Subscription Configuration**
 *
 * Three tiers, separated by what the automation is allowed to do rather
 * than by how much of it you get:
 *
 *   Signal   — read everything. The board, the tape, the smart-money
 *              leaderboard, and every decision the engine would make,
 *              with its evidence. No orders.
 *   Auto     — the same, plus automated execution on connected venue
 *              accounts, within the limits a strategy declares.
 *   Desk     — Auto without the strategy cap, plus the research runs
 *              that cost real model tokens.
 *
 * The price keys are what Stripe knows and what `entitlements.ts`
 * matches on, so they are stable identifiers, not display names — the
 * plan tier is the first segment and everything after it is billing
 * cadence.
 */
export const plans = [
    {
      productName: 'PredictHQ Signal',
      description: 'Every market, the full trade tape, and the decisions the engine would make, with the evidence behind each one.',
      pricing: [
        {
          key: 'predicthq_signal_monthly',
          price: 2900,
          interval: 'month',
          currency: 'usd',
        },
        {
          key: 'predicthq_signal_yearly',
          price: 29000,
          interval: 'year',
          currency: 'usd',
        },
      ],
      metadata: {
        tier: 'signal',
        autoExecute: 'false',
        maxStrategies: '1',
        version: '1.0.0',
      },
    },
    {
      productName: 'PredictHQ Auto',
      description: 'Places the trades. Connect Kalshi and Polymarket, set the limits, and the engine executes inside them.',
      pricing: [
        {
          key: 'predicthq_auto_monthly',
          price: 9900,
          interval: 'month',
          currency: 'usd',
        },
        {
          key: 'predicthq_auto_yearly',
          price: 99000,
          interval: 'year',
          currency: 'usd',
        },
      ],
      metadata: {
        tier: 'auto',
        autoExecute: 'true',
        maxStrategies: '5',
        version: '1.0.0',
      },
    },
    {
      productName: 'PredictHQ Desk',
      description: 'Unlimited strategies, deeper model research on every candidate, and priority ingestion.',
      pricing: [
        {
          key: 'predicthq_desk_monthly',
          price: 29900,
          interval: 'month',
          currency: 'usd',
        },
        {
          key: 'predicthq_desk_yearly',
          price: 299000,
          interval: 'year',
          currency: 'usd',
        },
      ],
      metadata: {
        tier: 'desk',
        autoExecute: 'true',
        maxStrategies: 'unlimited',
        version: '1.0.0',
      },
    },
  ] satisfies NonNullable<SaasConfig['plans']>

export default {
  plans,

  webhook: {
    endpoint: '/api/billing/webhook',
    secret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },

  currencies: ['usd'],
  coupons: [],

  products: [
    {
      name: 'PredictHQ Signal',
      description: 'Prediction-market intelligence: markets, tape, smart money, and decision previews.',
      images: [],
    },
    {
      name: 'PredictHQ Auto',
      description: 'Automated execution on Kalshi and Polymarket, inside limits you set.',
      images: [],
    },
    {
      name: 'PredictHQ Desk',
      description: 'Unlimited strategies and deep research on every candidate.',
      images: [],
    },
  ],
} satisfies SaasConfig
