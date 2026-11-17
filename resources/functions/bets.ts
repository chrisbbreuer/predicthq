/**
 * Display helpers shared by the bets pages (`/positions`, `/bet`).
 *
 * Pure functions over plain data: no DOM, no globals. The charts are
 * built as SVG strings and bound with `x-html`, which keeps the markup
 * free of the expressions the stx runtime cannot evaluate (a `.map` in an
 * attribute fails silently) and lets one chart function serve a 120px
 * sparkline and a full-width game chart alike.
 */

export type Point = [number, number]

export interface ChartLine {
  points: Point[]
  /** Any CSS colour, including `var(--pos)` or a `color-mix()`. */
  color: string
  /** Shade the area under this line, the way the venue draws the leader. */
  fill?: boolean
}

let gradientSeq = 0

export function usd(value: unknown): string {
  const amount = Number(value) || 0
  const body = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (amount < 0 ? '-$' : '$') + body
}

export function signedUsd(value: unknown): string {
  const amount = Number(value) || 0
  return (amount > 0 ? '+' : '') + usd(amount)
}

export function tone(value: unknown): string {
  const amount = Number(value) || 0
  return amount > 0.004 ? 'pos' : (amount < -0.004 ? 'neg' : 'muted')
}

export function cents(value: unknown): string {
  return `${Math.round((Number(value) || 0) * 100)}¢`
}

/** A probability as a whole percentage, with `<1%` and `>99%` at the ends. */
export function pct(value: unknown): string {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)))
    return '—'
  const p = Number(value) * 100
  if (p > 0 && p < 1)
    return '<1%'
  if (p < 100 && p > 99)
    return '>99%'
  return `${Math.round(p)}%`
}

export function contracts(value: unknown): string {
  const n = Math.round((Number(value) || 0) * 100) / 100
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * A team colour that holds up on both themes: mixed a quarter of the way
 * toward the text colour, so a navy brightens on black and a yellow
 * darkens on white without either losing its identity.
 */
export function teamColor(hex: unknown, fallback = 'var(--text)'): string {
  const text = String(hex ?? '')
  return /^#[0-9a-f]{6}$/i.test(text) ? `color-mix(in srgb, ${text} 76%, var(--text))` : fallback
}

/** `Q2 · 9:00`, `P3 · 4:12`, `Top 5th`, `67'` — the venue's shorthand. */
export function gameClock(game: any): string {
  if (!game)
    return ''
  if (game.state === 'pre')
    return startLabel(game.startsAt)
  if (game.state === 'post')
    return game.status || 'Final'

  const status = String(game.status || '')
  const clock = String(game.clock || '')
  const period = Number(game.period) || 0
  if (/half|end|delay|ot\b|overtime/i.test(status) && (!clock || clock === '0.0' || clock === '0:00'))
    return status.replace(/^.*?-\s*/, '')
  if (!period || !clock)
    return status

  switch (game.league) {
    case 'nba':
    case 'wnba':
    case 'nfl':
    case 'ncaaf':
      return `${period > 4 ? `OT${period > 5 ? period - 4 : ''}` : `Q${period}`} · ${clock}`
    case 'ncaab':
      return `${period > 2 ? 'OT' : `H${period}`} · ${clock}`
    case 'nhl':
      return `${period > 3 ? 'OT' : `P${period}`} · ${clock}`
    default:
      return status
  }
}

export function startLabel(value: unknown): string {
  const parsed = new Date(String(value || ''))
  if (!Number.isFinite(parsed.getTime()))
    return 'Scheduled'

  const today = new Date()
  const sameDay = parsed.toDateString() === today.toDateString()
  const time = parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today ${time}` : `${parsed.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`
}

/** `ORL Magic` from ESPN's names, the way the venue titles a game. */
export function teamShort(team: any): string {
  if (!team)
    return ''
  const nickname = String(team.name || '').replace(String(team.location || ''), '').trim()
  return nickname ? `${team.abbreviation} ${nickname}` : String(team.abbreviation || team.name || '')
}

function trendColor(points: Point[]): string {
  if (points.length < 2)
    return 'var(--muted)'
  const delta = points[points.length - 1]![1] - points[0]![1]
  return delta > 0.005 ? 'var(--pos)' : (delta < -0.005 ? 'var(--neg)' : 'var(--muted)')
}

function stepPath(points: Point[], x: (t: number) => number, y: (p: number) => number): string {
  let d = ''
  for (let i = 0; i < points.length; i++) {
    const [t, p] = points[i]!
    const px = x(t).toFixed(1)
    const py = y(p).toFixed(1)
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`
  }
  return d
}

/**
 * A small trend line, auto-scaled to its own range so a move from 62% to
 * 66% is visible. Coloured by direction over the window: green up, red
 * down, grey flat.
 */
export function sparkSvg(points: Point[], width = 132, height = 40): string {
  if (!points || points.length < 2)
    return ''
  const t0 = points[0]![0]
  const t1 = points[points.length - 1]![0]
  let lo = Math.min(...points.map(point => point[1]))
  let hi = Math.max(...points.map(point => point[1]))
  if (hi - lo < 0.04) {
    const mid = (hi + lo) / 2
    lo = mid - 0.02
    hi = mid + 0.02
  }
  const pad = 3
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad * 2)
  const y = (p: number) => pad + (1 - (p - lo) / (hi - lo)) * (height - pad * 2)
  const color = trendColor(points)
  const id = `spk${++gradientSeq}`
  const line = stepPath(points, x, y)
  const last = points[points.length - 1]!
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" style="display:block;overflow:visible">`
    + `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:0.16"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>`
    + `<path d="${line}V${height}H${x(t0).toFixed(1)}Z" style="fill:url(#${id});stroke:none"/>`
    + `<path d="${line}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linejoin:round" vector-effect="non-scaling-stroke"/>`
    + `<circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="2.4" style="fill:${color}"/>`
    + `</svg>`
}

/**
 * The full chart: probability from 0 to 100% on a fixed axis, one stepped
 * line per outcome, the leader shaded, and a dot on each line's latest
 * value. A fixed axis is deliberate here — on a game chart the distance
 * from 50% is the information.
 */
export function chartSvg(lines: ChartLine[], start: number, end: number, width = 760, height = 300): string {
  const drawn = (lines || []).filter(line => line.points && line.points.length > 0)
  if (drawn.length === 0)
    return ''

  const top = 12
  const bottom = height - 12
  const right = width - 8
  const t0 = start || Math.min(...drawn.map(line => line.points[0]![0]))
  const t1 = Math.max(end || 0, ...drawn.map(line => line.points[line.points.length - 1]![0]))
  const x = (t: number) => ((Math.max(t0, t) - t0) / Math.max(1, t1 - t0)) * right
  const y = (p: number) => top + (1 - p) * (bottom - top)

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="none" aria-hidden="true" style="display:block;height:100%;overflow:visible">`
  for (const level of [0.25, 0.5, 0.75]) {
    svg += `<line x1="0" x2="${width}" y1="${y(level).toFixed(1)}" y2="${y(level).toFixed(1)}" style="stroke:var(--border);stroke-width:1;stroke-dasharray:${level === 0.5 ? '0' : '3 5'}" vector-effect="non-scaling-stroke"/>`
  }

  for (const line of drawn) {
    const points = line.points
    const d = stepPath(points, x, y)
    const lastX = x(points[points.length - 1]![0])
    if (line.fill) {
      const id = `chg${++gradientSeq}`
      svg += `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${line.color};stop-opacity:0.18"/><stop offset="1" style="stop-color:${line.color};stop-opacity:0"/></linearGradient></defs>`
      svg += `<path d="${d}V${bottom}H${x(points[0]![0]).toFixed(1)}Z" style="fill:url(#${id});stroke:none"/>`
    }
    svg += `<path d="${d}" style="fill:none;stroke:${line.color};stroke-width:2.2;stroke-linejoin:round" vector-effect="non-scaling-stroke"/>`
    if (lastX < right + 1)
      svg += `<path d="M${lastX.toFixed(1)} ${y(points[points.length - 1]![1]).toFixed(1)}H${right}" style="fill:none;stroke:${line.color};stroke-width:1.2;stroke-dasharray:2 4;opacity:0.5" vector-effect="non-scaling-stroke"/>`
  }
  return `${svg}</svg>`
}

/** The y position of a probability on `chartSvg`'s axis, as a CSS top %. */
export function chartTop(p: unknown, height = 300): string {
  const value = Math.max(0, Math.min(1, Number(p) || 0))
  const top = 12
  const bottom = height - 12
  return `${(((top + (1 - value) * (bottom - top)) / height) * 100).toFixed(2)}%`
}

/** Three evenly spaced time labels under a chart. */
export function axisLabels(start: number, end: number, intervalMinutes: number): string[] {
  if (!start || !end || end <= start)
    return []
  const format = (seconds: number) => {
    const at = new Date(seconds * 1000)
    return intervalMinutes >= 60
      ? at.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return [format(start), format(start + (end - start) / 2), format(end)]
}
