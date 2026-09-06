import { describe, expect, it } from 'bun:test'

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map(channel => Number.parseInt(channel, 16) / 255) ?? []
  const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('shared theme contrast', () => {
  it('keeps normal and secondary text at WCAG AA contrast', () => {
    expect(contrast('#0f141c', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#5b6780', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#667085', '#f4f7fb')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#087a4b', '#ffffff')).toBeGreaterThanOrEqual(4.5)

    expect(contrast('#f2f3f5', '#16181c')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#9698a0', '#16181c')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#81848d', '#16181c')).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps interactive boundaries at non-text contrast', () => {
    expect(contrast('#8290a3', '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrast('#626975', '#16181c')).toBeGreaterThanOrEqual(3)
  })

  it('keeps selected and semantic states readable in both themes', () => {
    expect(contrast('#ffffff', '#3e64e0')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#087a4b')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#d92d20')).toBeGreaterThanOrEqual(4.5)

    expect(contrast('#08090b', '#5b83f5')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#08090b', '#34d399')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#08090b', '#f87171')).toBeGreaterThanOrEqual(4.5)
  })
})
