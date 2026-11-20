import type { FinalBox } from './box-history'
import type { ReportedInjury } from '../fundamentals/injuries'

const day = 86_400_000
const cutoff = 30 * 60_000

type Score = [home: number, away: number]
type Feature = 'rest' | 'boxScore' | 'injuries'
type Variant = 'leagueAverage' | 'offenseDefense' | 'recentForm' | 'opponentAdjusted' | Feature

export interface Fixture {
  id: number
  starts: number
  home: number
  away: number
  neutral?: boolean
}

export interface PlayedGame extends Fixture {
  final: Score
  knownAt: number
  box?: FinalBox
  boxKnownAt?: number
}

export interface InjurySnapshot {
  at: number
  injuries: ReportedInjury[]
}

type Injuries = Map<number, InjurySnapshot[]>

interface Observation {
  game: PlayedGame
  home: boolean
  offense: number
  defense: number
  opponentOffense: number
  opponentDefense: number
}

interface TeamForm {
  games: number
  pointsFor: number
  pointsAgainst: number
  lastFive: string
  restDays: number | null
  injuriesAsOf: number | null
}

interface Projection {
  scores: Partial<Record<Variant, Score>>
  inputs: { home: TeamForm, away: TeamForm }
  corrections: Partial<Record<Feature, [number, number]>>
}

interface FeatureFit { x2: Score, xy: Score, games: number }
interface Rating { offense: number, defense: number }

const statsBySport: Record<string, string[]> = {
  basketball: ['assists', 'offensiveRebounds', 'turnovers', 'fieldGoalPct', 'threePointFieldGoalPct'],
  football: ['netPassingYards', 'rushingYards', 'totalOffensivePlays', 'turnovers', 'firstDowns'],
  hockey: ['shotsTotal', 'powerPlayGoals', 'giveaways', 'blockedShots'],
  baseball: ['hits', 'walks', 'homeRuns', 'strikeouts'],
  soccer: ['accuratePasses', 'totalPasses', 'possessionPct', 'shotsOnTarget', 'totalShots', 'wonCorners'],
}

const leagueSport: Record<string, string> = {
  nba: 'basketball', wnba: 'basketball', ncaab: 'basketball', ncaaw: 'basketball',
  nfl: 'football', ncaaf: 'football', nhl: 'hockey', mlb: 'baseball',
}

const mean = (rows: number[]) => rows.reduce((sum, value) => sum + value, 0) / rows.length
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const rounded = (n: number) => Math.round(n * 10) / 10

function rating(games: Observation[], recent: boolean, adjusted: boolean): Rating {
  let offense = 0
  let defense = 0
  let weight = 0
  for (const [i, row] of games.entries()) {
    const w = recent ? 0.82 ** i : 1
    offense += w * (row.offense - (adjusted ? row.opponentDefense : 0))
    defense += w * (row.defense - (adjusted ? row.opponentOffense : 0))
    weight += w
  }
  return { offense: offense / (3 + weight), defense: defense / (3 + weight) }
}

function scoreFor(average: Score, home: Rating, away: Rating): Score {
  return [Math.max(0, average[0] + home.offense + away.defense), Math.max(0, average[1] + away.offense + home.defense)]
}

function snapshot(reports: Injuries, team: number, at: number) {
  return reports.get(team)?.find(row => row.at <= at && at - row.at <= 6 * 3_600_000)
}

function teamForm(rows: Observation[], at: number, injuries?: InjurySnapshot): TeamForm {
  const recent = rows.slice(0, 8)
  const score = (row: Observation) => row.home ? row.game.final : [...row.game.final].reverse()
  return {
    games: rows.length,
    pointsFor: rounded(mean(recent.map(row => score(row)[0]!))),
    pointsAgainst: rounded(mean(recent.map(row => score(row)[1]!))),
    lastFive: recent.slice(0, 5).map(row => {
      const [scored, conceded] = score(row)
      return scored! > conceded! ? 'W' : scored! < conceded! ? 'L' : 'D'
    }).join(''),
    restDays: rows[0] ? rounded((at - rows[0].game.starts) / day) : null,
    injuriesAsOf: injuries?.at ?? null,
  }
}

function statValue(value: string | undefined): number | null {
  if (!value || !/^-?\d+(?:\.\d+)?%?$/.test(value.trim()))
    return null
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : null
}

function boxFeature(rows: Observation[], keys: string[], at: number) {
  const recent = rows.filter(row => row.game.box && (row.game.boxKnownAt ?? Infinity) <= at).slice(0, 8)
  if (recent.length < 3)
    return null
  const signals = keys.flatMap((key) => {
    const samples = recent.flatMap((row) => {
      const box = row.game.box!.teamStats
      const own = statValue((row.home ? box.home : box.away)[key])
      const opponent = statValue((row.home ? box.away : box.home)[key])
      return own === null || opponent === null || Math.abs(own) + Math.abs(opponent) === 0 ? [] : [(own - opponent) / (Math.abs(own) + Math.abs(opponent))]
    })
    if (samples.length < 3)
      return []
    return [mean(samples) * (/turnovers|giveaways|strikeouts/.test(key) ? -1 : 1)]
  })
  return signals.length >= 2 ? mean(signals) : null
}

function injuryBurden(report: InjurySnapshot, rows: Observation[], at: number) {
  const minutes = new Map<string, number[]>()
  for (const row of rows.slice(0, 8)) {
    if ((row.game.boxKnownAt ?? Infinity) > at)
      continue
    const box = row.game.box?.players[row.home ? 'home' : 'away']
    const column = box?.labels.indexOf('MIN') ?? -1
    if (column < 0)
      continue
    for (const player of box?.players ?? []) {
      const playingTime = player.stats[column]
      if (!player.id || player.dnp || !playingTime)
        continue
      const [m, s] = playingTime.split(':').map(Number)
      if (!Number.isFinite(m))
        continue
      const games = minutes.get(player.id) ?? []
      games.push(m! + (s || 0) / 60)
      minutes.set(player.id, games)
    }
  }
  return report.injuries.reduce((sum, player) => {
    const history = minutes.get(player.athleteId)
    const positionalWeight = /^(?:QB|GK|G)$/i.test(player.position) ? 1.5 : .5
    return sum + player.severity * (history?.length ? clamp(mean(history) / 25, 0.1, 1.8) : positionalWeight)
  }, 0)
}

const variants: Variant[] = ['leagueAverage', 'offenseDefense', 'recentForm', 'opponentAdjusted', 'rest', 'boxScore', 'injuries']
const features: Feature[] = ['rest', 'boxScore', 'injuries']
const winSide = ([home, away]: Score) => home === away ? 0 : home > away ? 1 : -1

function metric() {
  return { games: 0, sideHits: 0, teamScoreError: 0, totalError: 0, marginError: 0 }
}

function poisson(rate: number) {
  const masses = [Math.exp(-rate)]
  for (let goals = 1; goals <= 12; goals++)
    masses.push(masses[goals - 1]! * rate / goals)
  return masses
}

function projectedSide(score: Score, soccer: boolean) {
  if (!soccer)
    return winSide(score)
  const home = poisson(score[0])
  const away = poisson(score[1])
  let draw = 0
  let homeWin = 0
  let awayWin = 0
  for (let goals = 0; goals < home.length; goals++) {
    draw += home[goals]! * away[goals]!
    for (let less = 0; less < goals; less++) {
      homeWin += home[goals]! * away[less]!
      awayWin += away[goals]! * home[less]!
    }
  }
  return draw >= Math.max(homeWin, awayWin) ? 0 : homeWin > awayWin ? 1 : -1
}

function updateMetric(bucket: ReturnType<typeof metric>, [home, away]: Score, final: Score, soccer: boolean) {
  bucket.games++
  bucket.sideHits += Number(projectedSide([home, away], soccer) === winSide(final))
  const h = home - final[0]
  const a = away - final[1]
  bucket.teamScoreError += (Math.abs(h) + Math.abs(a)) / 2
  bucket.totalError += Math.abs(h + a)
  bucket.marginError += Math.abs(h - a)
}

function summarize(bucket: ReturnType<typeof metric>) {
  const { games, sideHits } = bucket
  const error = (value: number) => games ? rounded(value / games) : null
  return { games, sideHits, teamScoreMAE: error(bucket.teamScoreError), totalMAE: error(bucket.totalError), marginMAE: error(bucket.marginError) }
}

export function replayScores(league: string, history: PlayedGame[], reports: Injuries, fixtures: Fixture[] = [], since = -Infinity) {
  const byTime = [...history].sort((a, b) => a.knownAt - b.knownAt)
  const scores: Score[] = []
  const teams = new Map<number, Observation[]>()
  const deferred = new Map<number, { base: Score | null, home: Rating, away: Rating, projection: Projection | null }>()
  const fitted = Object.fromEntries(features.map(key => [key, { x2: [0, 0], xy: [0, 0], games: 0 }])) as Record<Feature, FeatureFit>
  const comparison = Object.fromEntries(variants.map(key => [key, { model: metric(), baseline: metric() }])) as Record<Variant, { model: ReturnType<typeof metric>, baseline: ReturnType<typeof metric> }>
  const results = new Map<number, Projection>()
  let index = 0
  let qualified = 0
  const walk: Array<Fixture | PlayedGame> = [...history, ...fixtures].sort((a, b) => a.starts - b.starts || a.id - b.id)
  const sport = leagueSport[league] ?? 'soccer'
  const keys = statsBySport[sport]!
  for (const game of walk) {
    const at = game.starts - cutoff
    while (byTime[index] && byTime[index]!.knownAt < at) {
      const final = byTime[index++]!
      const sample = deferred.get(final.id)
      scores.push(final.final)
      if (scores.length > 500)
        scores.shift()
      const base = sample?.base ?? final.final
      for (const home of [true, false]) {
        const team = home ? final.home : final.away
        const list = teams.get(team) ?? []
        const opp = home ? sample?.away : sample?.home
        const side = home ? 0 : 1
        list.push({ game: final, home, offense: final.final[side] - base[side], defense: final.final[1 - side]! - base[1 - side]!,
          opponentOffense: opp?.offense ?? 0, opponentDefense: opp?.defense ?? 0 })
        teams.set(team, list.sort((a, b) => b.game.starts - a.game.starts).slice(0, 25))
      }
      const projection = sample?.projection
      const best = projection?.scores.opponentAdjusted
      if (projection && best) {
        for (const feature of features) {
          const signal = projection.corrections[feature]
          if (!signal)
            continue
          const fit = fitted[feature]
          fit.games++
          for (const i of [0, 1] as const) {
            fit.x2[i] += signal[i] ** 2
            fit.xy[i] += signal[i] * (final.final[i] - best[i])
          }
        }
      }
      deferred.delete(final.id)
    }
    const home = (teams.get(game.home) ?? []).filter(row => game.starts - row.game.starts <= 120 * day)
    const away = (teams.get(game.away) ?? []).filter(row => game.starts - row.game.starts <= 120 * day)
    const average = (scores.length ? [mean(scores.map(score => score[0])), mean(scores.map(score => score[1]))] : [0, 0]) as Score
    const base: Score = game.neutral ? [mean(average), mean(average)] : average
    const homeRating = rating(home, true, false)
    const awayRating = rating(away, true, false)
    let projection: Projection | null = null
    if (scores.length >= 20 && home.length >= 3 && away.length >= 3) {
      qualified++
      const homeInjury = snapshot(reports, game.home, at)
      const awayInjury = snapshot(reports, game.away, at)
      const inputs = { home: teamForm(home, game.starts, homeInjury), away: teamForm(away, game.starts, awayInjury) }
      const matchup = scoreFor(base, rating(home, false, false), rating(away, false, false))
      const form = scoreFor(base, homeRating, awayRating)
      const adjusted = scoreFor(base, rating(home, true, true), rating(away, true, true))
      const corrections: Projection['corrections'] = {}
      const recovery = (rows: Observation[]) => Math.exp(-(game.starts - rows[0]!.game.starts) / day)
      const rest = recovery(away) - recovery(home)
      corrections.rest = [rest, -rest]
      const homeStats = boxFeature(home, keys, at)
      const awayStats = boxFeature(away, keys, at)
      if (homeStats !== null && awayStats !== null)
        corrections.boxScore = [homeStats - awayStats, awayStats - homeStats]
      if (homeInjury && awayInjury) {
        const burden = injuryBurden(awayInjury, away, at) - injuryBurden(homeInjury, home, at)
        corrections.injuries = [burden, -burden]
      }
      const projected: Projection['scores'] = { leagueAverage: base, offenseDefense: matchup, recentForm: form, opponentAdjusted: adjusted }
      for (const feature of features) {
        const signal = corrections[feature]
        const fit = fitted[feature]
        if (signal && fit.games >= 25) {
          projected[feature] = [0, 1].map(i => {
            const side = i as 0 | 1
            const residual = signal[side] * fit.xy[side] / (fit.x2[side] + 15)
            return Math.max(0, adjusted[side] + clamp(residual, -.12 * base[side], .12 * base[side]))
          }) as Score
        }
      }
      projection = { inputs, corrections, scores: projected }
    }
    if ('final' in game) {
      deferred.set(game.id, { base: scores.length >= 5 ? base : null, home: homeRating, away: awayRating, projection })
      if (!projection || game.starts < since)
        continue
      for (const key of variants) {
        const predicted = projection.scores[key]
        if (predicted) {
          updateMetric(comparison[key].model, predicted, game.final, sport === 'soccer')
          updateMetric(comparison[key].baseline, projection.scores[features.includes(key as Feature) ? 'opponentAdjusted' : 'leagueAverage']!, game.final, sport === 'soccer')
        }
      }
    }
    else if (projection) {
      results.set(game.id, projection)
    }
  }

  return {
    qualified,
    fixtures: results,
    metrics: Object.fromEntries(variants.map(key => [key, { model: summarize(comparison[key].model), pairedBaseline: summarize(comparison[key].baseline) }])),
    featureTraining: Object.fromEntries(features.map(key => [key, fitted[key].games])),
  }
}
