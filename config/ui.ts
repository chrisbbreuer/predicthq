import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * STX Configuration for Stacks
 * Note: Dashboard mode overrides these settings via serve() options
 */

export default {
  // Components directory - for user-defined components
  componentsDir: 'resources/components',

  // Layouts directory - for layout templates
  layoutsDir: 'resources/layouts',

  // Partials directory - for partial templates
  partialsDir: 'resources/partials',

  /*
   * Page warm-up before a new release takes traffic.
   *
   * During a zero-downtime deploy the old release keeps serving while the
   * new one renders its pages once, so the first visitors after a deploy
   * get warm pages. stx holds the port for the whole budget, and with every
   * page on the site (dashboards included) it ran out the default sixty
   * seconds on each deploy. The pages people land on go first and render
   * eight at a time; after fifteen seconds the release binds and anything
   * left warms on its first visit.
   */
  pageWarmup: {
    paths: ['/', '/positions', '/live', '/scores', '/odds', '/scanner'],
    budgetMs: 15_000,
    concurrency: 8,
  },
} satisfies UiOptions
