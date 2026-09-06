import { describe, expect, it } from 'bun:test'
import { iconForLeague, iconForSport, sportIcon, teamAbbreviation, teamFor } from '../../app/Support/branding'

describe('copyright-safe sports marks', () => {
  it('uses bundled Iconify classes for every sport instead of image URLs', () => {
    expect(Object.values(sportIcon).every(icon => icon.startsWith('i-hugeicons-'))).toBe(true)
    expect(iconForLeague('ncaaf')).toBe('i-hugeicons-american-football')
    expect(iconForLeague('nba')).toBe('i-hugeicons-basketball-01')
    expect(iconForSport('Premier League Soccer')).toBe('i-hugeicons-football')
  })

  it('turns team names into neutral, readable monograms', () => {
    expect(teamAbbreviation('New Mexico St.')).toBe('NMS')
    expect(teamAbbreviation('San Diego St. -3.5')).toBe('SDS')
    expect(teamAbbreviation('LSU')).toBe('LSU')
  })

  it('never embeds a remote crest or team colour in a team chip', () => {
    const chip = teamFor('Los Angeles Lakers')

    expect(chip.text).toBe('LAL')
    expect(chip.style).not.toContain('url(')
    expect(chip.style).toContain('var(--surface-2)')
  })
})
