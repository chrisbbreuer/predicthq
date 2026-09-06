/**
 * Shared display marks for PredictHQ.
 *
 * Publisher marks remain compact text tiles. Sports use open Iconify glyphs,
 * while teams use neutral monograms instead of club crests, league marks, or
 * team colour systems. That keeps the visual language useful without making
 * our interface depend on third-party trademark artwork.
 */

export interface BookBrand { bg: string, fg: string, mark: string, url: string }
export interface TeamBrand { abbr: string, bg: string, fg: string }
export interface TeamChip extends TeamBrand { style: string, text: string }

export const bookBrand: Record<string, BookBrand> = {
  draftkings: { bg: '#53d337', fg: '#06230f', mark: 'DK', url: 'https://sportsbook.draftkings.com' },
  fanduel: { bg: '#1493ff', fg: '#ffffff', mark: 'FD', url: 'https://sportsbook.fanduel.com' },
  betmgm: { bg: '#caa64f', fg: '#11130f', mark: 'MGM', url: 'https://sports.betmgm.com' },
  caesars: { bg: '#0d5c43', fg: '#e7c884', mark: 'CZR', url: 'https://www.caesars.com/sportsbook-and-casino' },
  bet365: { bg: '#027b5b', fg: '#ffe400', mark: '365', url: 'https://www.bet365.com' },
  pinnacle: { bg: '#e4022d', fg: '#ffffff', mark: 'PIN', url: 'https://www.pinnacle.com' },
  polymarket: { bg: '#1652f0', fg: '#ffffff', mark: 'PM', url: 'https://polymarket.com' },
  kalshi: { bg: '#00b894', fg: '#06231c', mark: 'KAL', url: 'https://kalshi.com' },
}

export function brandFor(slug: string, short: string): BookBrand {
  return bookBrand[slug] || { bg: '#64748b', fg: '#ffffff', mark: short, url: '#' }
}

const sportIcons = {
  baseball: 'i-hugeicons-baseball',
  basketball: 'i-hugeicons-basketball-01',
  football: 'i-hugeicons-american-football',
  hockey: 'i-hugeicons-ice-hockey',
  soccer: 'i-hugeicons-football',
  tennis: 'i-hugeicons-tennis-ball',
  golf: 'i-hugeicons-golf-ball',
  racing: 'i-hugeicons-racing-flag',
  combat: 'i-hugeicons-boxing-glove-01',
  default: 'i-hugeicons-champion',
} as const

export const sportIcon: Record<string, string> = {
  Baseball: sportIcons.baseball,
  Basketball: sportIcons.basketball,
  Football: sportIcons.football,
  Hockey: sportIcons.hockey,
  Soccer: sportIcons.soccer,
  Tennis: sportIcons.tennis,
  Golf: sportIcons.golf,
  Racing: sportIcons.racing,
  Combat: sportIcons.combat,
}

const leagueSport: Record<string, keyof typeof sportIcons> = {
  nfl: 'football',
  ncaaf: 'football',
  nba: 'basketball',
  ncaab: 'basketball',
  wnba: 'basketball',
  mlb: 'baseball',
  nhl: 'hockey',
  epl: 'soccer',
  soccer: 'soccer',
  atp: 'tennis',
  wta: 'tennis',
  pga: 'golf',
  mma: 'combat',
  ufc: 'combat',
  f1: 'racing',
}

export function iconForLeague(league: string): string {
  return sportIcons[leagueSport[league.trim().toLowerCase()] ?? 'default']
}

export function iconForSport(sport: string): string {
  const normalized = sport.trim().toLowerCase()
  if (normalized.includes('basket'))
    return sportIcons.basketball
  if (normalized.includes('baseball'))
    return sportIcons.baseball
  if (normalized.includes('american football') || normalized === 'football')
    return sportIcons.football
  if (normalized.includes('hockey'))
    return sportIcons.hockey
  if (normalized.includes('soccer') || normalized.includes('premier league'))
    return sportIcons.soccer
  if (normalized.includes('tennis'))
    return sportIcons.tennis
  if (normalized.includes('golf'))
    return sportIcons.golf
  if (normalized.includes('racing') || normalized.includes('formula'))
    return sportIcons.racing
  if (normalized.includes('mma') || normalized.includes('ufc') || normalized.includes('boxing'))
    return sportIcons.combat
  return sportIcons.default
}

/** Produce a compact neutral mark without reproducing a team's visual IP. */
export function teamAbbreviation(label: string): string {
  const cleaned = label
    .replace(/^(?:yes|no)\s+/i, '')
    .replace(/\s+[+-]?\d+(?:\.\d+)?$/, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
  if (!cleaned)
    return '—'

  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 1)
    return words[0]!.slice(0, 3).toUpperCase()
  return words.slice(0, 3).map(word => word[0]).join('').toUpperCase()
}

/** Resolve a neutral team/selection chip, handling spreads and totals. */
export function teamFor(label: string): TeamChip {
  let base: TeamBrand
  if (/^(?:over|under)\b/i.test(label)) {
    const over = /^over/i.test(label)
    base = { abbr: over ? 'O' : 'U', bg: 'var(--surface-2)', fg: over ? 'var(--pos)' : 'var(--neg)' }
  }
  else if (/^draw$/i.test(label.trim())) {
    base = { abbr: 'X', bg: 'var(--surface-2)', fg: 'var(--muted)' }
  }
  else {
    base = { abbr: teamAbbreviation(label), bg: 'var(--surface-2)', fg: 'var(--text)' }
  }

  return {
    ...base,
    style: `background-color:${base.bg};color:${base.fg};border:1px solid var(--border)`,
    text: base.abbr,
  }
}
