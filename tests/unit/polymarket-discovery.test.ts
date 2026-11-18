import { describe, expect, it } from 'bun:test'
import { fetchLeague } from '../../app/Services/odds/books/polymarket'

/**
 * Gamma embeds every market in every event: an NBA game carries ~500, nearly
 * all props. Discovery lists the league without them and fetches only the
 * games near enough to price, keeping only the markets the adapter reads.
 */

const NOW = Date.parse('2026-11-18T03:00:00Z')

function stubGamma() {
  const requests: string[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body))
  const get = async (url: string) => {
    requests.push(url)
    if (url.endsWith('/sports'))
      return json([{ sport: 'nba', series: '10345' }])
    if (url.includes('/events?')) {
      expect(url).toContain('include_markets=false')
      return json([
        { id: '1', eventDate: '2026-11-18', teams: [] },
        { id: '2', eventDate: '2026-11-19', teams: [] },
        { id: '3', eventDate: '2026-12-25', teams: [] },
      ])
    }
    const id = url.split('/events/')[1]
    return json({
      id,
      markets: [
        { id: `${id}-ml`, sportsMarketType: 'moneyline' },
        { id: `${id}-sp`, sportsMarketType: 'spreads' },
        { id: `${id}-pts`, sportsMarketType: 'points' },
        { id: `${id}-reb`, sportsMarketType: 'rebounds' },
      ],
    })
  }
  return { get, requests }
}

describe('polymarket discovery', () => {
  it('fetches only near games, keeps only priced markets, and reuses them', async () => {
    const { get, requests } = stubGamma()
    const events = (await fetchLeague('nba', get, NOW))!
    expect(events.map(event => event.id)).toEqual(['1', '2'])
    expect(events[0]!.markets!.map(market => market.id)).toEqual(['1-ml', '1-sp'])
    expect(requests.filter(url => /\/events\/\d+$/.test(url))).toHaveLength(2)

    requests.length = 0
    await fetchLeague('nba', get, NOW + 60_000)
    expect(requests.filter(url => /\/events\/\d+$/.test(url))).toHaveLength(0)

    requests.length = 0
    await fetchLeague('nba', get, NOW + 11 * 60_000)
    expect(requests.filter(url => /\/events\/\d+$/.test(url))).toHaveLength(2)
  })
})
