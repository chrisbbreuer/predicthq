import type { LiveTeam } from './live-games'
import type { Suggestion } from './suggestions'
import { cached } from '../prediction-markets/kalshi-public'
import { liveGameFor } from './live-games'

function team(team: LiveTeam) {
  return { name: team.name, abbreviation: team.abbreviation, logo: team.logo }
}

/** Load only the public identity of the matchup, shared by users viewing the same market. */
export async function suggestionMatchups(tickets: Suggestion[]) {
  const legs = new Map(tickets.flatMap(ticket => ticket.legs.map(leg => [leg.ticker, leg] as const)))
  const matches = await Promise.all([...legs].map(async ([ticker, leg]) => {
    return await cached(`suggestion-matchup:${ticker}`, 5 * 60_000, async () => {
      const game = await liveGameFor(ticker, leg.side, undefined, leg.title)
      return game ? [ticker, { league: game.league, away: team(game.away), home: team(game.home) }] as const : null
    }).catch(() => null)
  }))
  return Object.fromEntries(matches.filter(match => match !== null))
}
