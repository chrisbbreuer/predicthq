import type { ImagesConfig } from '@stacksjs/types'

/**
 * Generated imagery: link-preview cards and the favicon set.
 *
 * Built with `buddy generate:og` and `buddy generate:app-icons`. The card
 * copy says what the product does in plain terms and makes no claim the app
 * cannot back; change it here when the page headlines change, so a shared
 * link never previews copy the site no longer says.
 */
export default {
  // Inter (SIL Open Font License), TrueType as the renderer requires.
  fonts: {
    title: 'resources/assets/fonts/inter/Inter-Bold.ttf',
    body: 'resources/assets/fonts/inter/Inter-Regular.ttf',
  },
  brand: 'PredictHQ',
  // Light mark on the black cards; the dark one is the favicon.
  mark: 'resources/assets/brand/mark-light.svg',
  markPlate: false,
  color: '#ffffff',
  mutedColor: '#a3a3a3',
  accent: '#22c77a',
  background: {
    color: '#000000',
    glows: [{ x: 0.85, y: 0.15, radius: 0.55, color: 'rgba(255,255,255,0.06)' }],
  },

  social: {
    enabled: true,
    outputDir: 'public/images/og',
    publicPath: '/images/og',
    presets: ['og'],
    format: 'png',
    text: { titleSize: 76, eyebrowSize: 30, subtitleSize: 34 },
    pages: [
      {
        path: '/',
        eyebrow: 'Prediction markets',
        title: 'Every prediction market, one clear view',
        subtitle: 'Kalshi and Polymarket prices, live scores, and your bets.',
      },
      {
        path: '/scanner',
        eyebrow: 'Live scanner',
        title: 'See which markets are moving right now',
        subtitle: 'Price changes over 5, 15, and 60 minutes for every live game.',
      },
      {
        path: '/positions',
        eyebrow: 'My bets',
        title: 'Follow every bet as the game plays out',
        subtitle: 'Live scores, player stats on props, and parlays leg by leg.',
      },
      {
        path: '/odds',
        eyebrow: 'Odds board',
        title: 'Compare the price before you place it',
        subtitle: 'Sportsbooks and prediction markets side by side.',
      },
      {
        path: '/pricing',
        eyebrow: 'Pricing',
        title: 'Start free, upgrade when it pays for itself',
        subtitle: 'Signals, automation, and API access by plan.',
      },
    ],
  },

  appIcons: {
    enabled: true,
    source: 'resources/assets/brand/icon.png',
    outputDir: 'public/images/icons',
    platforms: [],
    favicon: true,
    faviconDir: 'public',
    manifest: {
      name: 'PredictHQ',
      shortName: 'PredictHQ',
      themeColor: '#000000',
      backgroundColor: '#000000',
    },
  },
} satisfies ImagesConfig
