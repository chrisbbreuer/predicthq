import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * Contrast is checked against the tokens the pages actually ship, read out
 * of `resources/partials/tokens.stx`, rather than against copies of the
 * hex values. A palette change that breaks readability fails here, and a
 * palette change that does not is not a test edit.
 */

const source = readFileSync(join(import.meta.dir, '../../resources/partials/tokens.stx'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = source.indexOf(`${selector} {`)
  if (start === -1)
    throw new Error(`No ${selector} block in tokens.stx`)
  const body = source.slice(start, source.indexOf('}', start))
  const tokens: Record<string, string> = {}
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi))
    tokens[match[1]!] = match[2]!
  return tokens
}

const light = block(':root')
const dark = block(':root[data-theme="dark"]')

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map(channel => Number.parseInt(channel, 16) / 255) ?? []
  const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrast(foreground: string | undefined, background: string | undefined): number {
  if (!foreground || !background)
    throw new Error('Missing token')
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('shared theme contrast', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
    it(`keeps text at WCAG AA on every ${name} surface`, () => {
      for (const surface of ['bg', 'surface', 'surface-2']) {
        expect(contrast(theme.text, theme[surface])).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.muted, theme[surface])).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.faint, theme[surface])).toBeGreaterThanOrEqual(4.5)
      }
    })

    it(`keeps up/down colours readable as text in ${name} mode`, () => {
      expect(contrast(theme.pos, theme.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.neg, theme.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.live, theme.surface)).toBeGreaterThanOrEqual(4.5)
    })

    it(`keeps primary buttons and control edges visible in ${name} mode`, () => {
      expect(contrast(theme['on-accent'], theme.accent)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme['border-strong'], theme.surface)).toBeGreaterThanOrEqual(3)
    })
  }
})
