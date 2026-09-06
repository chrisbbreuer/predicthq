import { describe, expect, it } from 'bun:test'

const fullPageViews = [
  'account.stx',
  'community.stx',
  'compare.stx',
  'compare/[competitor].stx',
  'features.stx',
  'features/api.stx',
  'features/automation.stx',
  'features/evidence.stx',
  'features/live.stx',
  'features/odds.stx',
  'features/risk.stx',
  'features/sheets.stx',
  'features/smart-money.stx',
  'index.stx',
  'live.stx',
  'login.stx',
  'markets.stx',
  'pipeline.stx',
  'positions.stx',
  'pricing.stx',
  'privacy.stx',
  'risk.stx',
  'scores/[league]/[day].stx',
  'scores/[league]/game/[id].stx',
  'signup.stx',
  'terms.stx',
]

describe('shared marketing shell', () => {
  it('uses the same footer on every full page', async () => {
    for (const view of fullPageViews) {
      const source = await Bun.file(`resources/views/${view}`).text()
      expect(source, view).toContain("@include('footer')")
      expect(source, view).not.toContain('<footer')
    }
  })

  it('keeps appearance controls in the footer, outside the top nav', async () => {
    const nav = await Bun.file('resources/partials/nav.stx').text()
    const footer = await Bun.file('resources/partials/footer.stx').text()

    expect(nav).not.toContain('toggleTheme')
    expect(nav).not.toContain('i-hugeicons-moon-02')
    expect(footer).toContain('toggleFooterTheme')
    expect(footer).toContain('Switch to light mode')
    expect(footer).toContain('Switch to dark mode')
  })

  it('groups the desktop navigation into accessible mega menus', async () => {
    const nav = await Bun.file('resources/partials/nav.stx').text()

    expect(nav).toContain('<summary class="gap-1 nav-summary">\n          Features')
    expect(nav).toContain('<summary class="gap-1 nav-summary">\n          Explore')
    expect(nav).toContain('aria-label="Mobile navigation"')
  })

  it('promises venue-limited live delivery instead of a five-minute refresh', async () => {
    const pricing = await Bun.file('resources/views/pricing.stx').text()
    expect(pricing).toContain('pushed to every paid account as venues permit')
    expect(pricing).not.toContain('refreshed every five minutes')
  })

  it('keeps the prediction-market loop and live desk on their realtime paths', async () => {
    const scheduler = await Bun.file('app/Scheduler.ts').text()
    const markets = await Bun.file('resources/views/markets.stx').text()

    expect(scheduler).toMatch(/job\('IngestPredictionMarkets'\)\s*\.everyMinute\(\)/)
    expect(markets).toContain("fetch('/api/markets/smart-money', { cache: 'no-store' })")
    expect(markets).toContain("fetch('/api/markets/whales', { cache: 'no-store' })")
    expect(markets).toContain("fetch('/api/markets/graph', { cache: 'no-store' })")
    expect(markets).toContain('setInterval(() => refreshFlow(), 60000)')
    expect(markets).toContain("channel: 'prediction-markets'")
    expect(markets).toContain("message.event === 'flow:updated'")
  })
})
