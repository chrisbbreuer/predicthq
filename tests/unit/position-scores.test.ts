import type { Game, Team } from '../../app/Services/scores/espn'
import { describe, expect, it } from 'bun:test'
import GetPositions from '../../app/Actions/Trading/GetPositions'
import { leagueFor } from '../../app/Services/scores/espn'
import {
  buildPositionScorecard,
  normalizeTeamName,
  parseMultiGameLegs,
  positionScorecards,
  scorecardKey,
} from '../../app/Services/trading/position-scores'

const MARKET = 'KXMVECROSSCATEGORY-SHARD1-S2026948CE961B05-4286C28F3BD'
const OUTCOMES = 'yes LSU,yes New Mexico,yes Cal Poly,yes New Mexico St.,yes Middle Tennessee,yes Sacramento St.,yes San Diego St.,yes South Dakota,yes Northwestern,yes UNLV,yes Southern Utah,yes Western Michigan'

describe('private book boundary', () => {
  it('rejects the portfolio before opening a database connection', async () => {
    const result = await GetPositions.handle()

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
    expect(await (result as Response).json()).toMatchObject({ message: 'Sign in to view your positions.' })
  })
})

function team(location: string, score: number | null): Team {
  return {
    abbreviation: location.slice(0, 4).toUpperCase(),
    location,
    name: `${location} Mascots`,
    shortName: location,
    score,
    record: null,
    winner: false,
  }
}

function game(
  id: string,
  home: Team,
  away: Team,
  state: 'pre' | 'in' | 'post' = 'in',
  startsAt = '2026-09-06T01:00:00.000Z',
): Game {
  return {
    id,
    league: 'ncaaf',
    startsAt,
    state,
    status: state === 'post' ? 'Final' : (state === 'pre' ? 'Scheduled' : '3rd Quarter'),
    clock: state === 'in' ? '8:14' : '',
    venue: null,
    broadcast: null,
    home,
    away,
  }
}

describe('multi-game position parsing', () => {
  it('turns the real Kalshi bundle into one leg per condition', () => {
    const legs = parseMultiGameLegs(OUTCOMES)

    expect(legs).toHaveLength(12)
    expect(legs[0]).toEqual({ choice: 'yes', team: 'LSU' })
    expect(legs.at(-1)).toEqual({ choice: 'yes', team: 'Western Michigan' })
  })

  it('does not mistake an ordinary outcome for a scorecard', () => {
    expect(parseMultiGameLegs('yes LSU')).toEqual([])
    expect(parseMultiGameLegs('Over 5.5 runs scored')).toEqual([])
  })

  it('normalizes state abbreviations without merging different schools', () => {
    expect(normalizeTeamName('New Mexico St.')).toBe(normalizeTeamName('New Mexico State'))
    expect(normalizeTeamName('South Dakota')).not.toBe(normalizeTeamName('South Dakota State'))
  })
})

describe('position scorecards', () => {
  const now = new Date('2026-09-06T02:00:00.000Z')

  it('matches selected teams exactly and reads the contract condition', () => {
    const legs = parseMultiGameLegs('yes South Dakota,no New Mexico St.,yes Northwestern')
    const games = [
      game('dakota-state', team('Northwestern', 27), team('South Dakota State', 18)),
      game('dakota', team('Northern Colorado', 7), team('South Dakota', 21)),
      game('new-mexico-state', team('New Mexico State', 23), team('Mercyhurst', 14), 'post'),
    ]

    const card = buildPositionScorecard(legs, games, now)

    expect(card).toMatchObject({ total: 3, found: 3, live: 2, final: 1, missing: 0 })
    expect(card.legs[0]).toMatchObject({ gameId: 'dakota', selectedScore: 21, opponent: 'Northern Colorado', standing: 'Ahead' })
    // A NO leg wants the named team to lose, so a final win loses the leg.
    expect(card.legs[1]).toMatchObject({ gameId: 'new-mexico-state', standing: 'Lost', tone: 'neg' })
    expect(card.legs[2]).toMatchObject({ gameId: 'dakota-state', selectedScore: 27, standing: 'Ahead' })
  })

  it('loads only after a private holding has revealed a multi-game contract', async () => {
    const calls: string[][] = []
    const holding = {
      venue: 'kalshi',
      marketExternalId: MARKET,
      side: 'yes',
      question: OUTCOMES,
      outcomeLabel: OUTCOMES,
      endsAt: '2026-09-08T00:00:00.000Z',
    }

    const cards = await positionScorecards([holding], {
      now,
      loadScoreboard: async (league, range) => {
        calls.push([league, range ?? ''])
        return [game('lsu', team('LSU', 31), team('Clemson', 3))]
      },
    })

    expect(calls).toEqual([['ncaaf', '20260905-20260908']])
    expect(cards.get(scorecardKey(holding))).toMatchObject({ total: 12, found: 1, live: 1, missing: 11 })
  })

  it('does not call the scoreboard for a normal position', async () => {
    let calls = 0
    const cards = await positionScorecards([{
      venue: 'kalshi',
      marketExternalId: 'SINGLE',
      side: 'yes',
      question: 'Will LSU win?',
      outcomeLabel: 'LSU',
      endsAt: '',
    }], {
      loadScoreboard: async () => {
        calls++
        return []
      },
    })

    expect(cards.size).toBe(0)
    expect(calls).toBe(0)
  })

  it('registers the college-football scoreboard with both subdivisions', () => {
    expect(leagueFor('ncaaf')).toMatchObject({ groups: ['80', '81'], limit: 100 })
  })
})
