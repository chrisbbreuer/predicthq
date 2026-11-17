import type { AppConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Application Configuration**
 *
 * This configuration defines all of your application options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  name: env.APP_NAME ?? 'PredictHQ',
  description: 'PredictHQ — Prediction Intel. Data-driven signals and automated positions across Kalshi and Polymarket.',
  env: env.APP_ENV ?? 'local',
  url: env.APP_URL ?? 'predicthq.localhost',
  redirectUrls: ['predicthq.org'],
  debug: env.DEBUG ?? false,
  key: env.APP_KEY,

  maintenanceMode: env.APP_MAINTENANCE ?? false,
  comingSoonMode: env.APP_COMING_SOON ?? false,
  comingSoonSecret: env.APP_COMING_SOON_SECRET ?? '',
  // docMode: true, // instead of example.com/docs, deploys example.com as main entry point for docs
  docMode: false,

  timezone: 'America/Los_Angeles',
  locale: 'en',
  fallbackLocale: 'en',
  cipher: 'aes-256-cbc',

  seo: {
    sitemap: {
      // `/market` renders one market by `?id=`; the bare path is a
      // not-found page and has no place in the sitemap.
      exclude: ['/market'],
    },
  },
} satisfies AppConfig
