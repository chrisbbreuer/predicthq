/** Offline analysis of cached props-backtest rows; makes no upstream requests.
 * bun tools/analyze-player-props.ts /path/to/props.json
 */
interface Row { ticker: string, day: string, name: string, stat: string, mid: number, model: number, bid: number, ask: number, outcome: number, n: number }
const path = process.argv[2]
if (!path)
  throw new Error('Pass the cached props.json path; this analysis makes no network requests.')
const rows = await Bun.file(path).json() as Row[]
if (!Array.isArray(rows) || rows.length === 0 || rows.some(r => ![r.mid, r.model, r.bid, r.ask, r.outcome].every(Number.isFinite) || ![0, 1].includes(r.outcome)))
  throw new Error('Invalid or empty cached prop observations')
function summarize(sample: Row[]) {
  const brier = (key: 'mid' | 'model') => sample.length ? sample.reduce((sum, r) => sum + (r[key] - r.outcome) ** 2, 0) / sample.length : null
  const bets = sample.flatMap((r) => {
    const fee = (price: number) => 0.07 * price * (1 - price)
    const yes = r.model - r.ask - fee(r.ask)
    const no = 1 - r.model - (1 - r.bid) - fee(1 - r.bid)
    const side = yes >= no
    const price = side ? r.ask : 1 - r.bid
    if (Math.max(yes, no) < 0.03 || price < 0.25 || price > 0.85)
      return []
    return [(r.outcome === Number(side) ? 1 / price : 0) - 1 - fee(price) / price]
  })
  return { observations: sample.length, marketBrier: brier('mid'), modelBrier: brier('model'), modelBets: bets.length, modelRoi: bets.length ? bets.reduce((a, b) => a + b, 0) / bets.length : null }
}
console.log(JSON.stringify({
  source: 'Recovered Claude backtest cache, ESPN site.web.api game logs and Kalshi T-30 quotes',
  dateRange: [...new Set(rows.map(r => r.day))].sort(), players: new Set(rows.map(r => r.name)).size,
  overall: summarize(rows), beforeNov14: summarize(rows.filter(r => r.day < '2026-11-14')), fromNov14: summarize(rows.filter(r => r.day >= '2026-11-14')),
  byStat: Object.fromEntries([...new Set(rows.map(r => r.stat))].map(stat => [stat, summarize(rows.filter(r => r.stat === stat))])),
  limitations: ['Short retrospective sample; thresholds and props on the same player/game are correlated observations.', 'Current-season game logs can contain fewer than twenty prior appearances; minimum was five.', 'Fractional DNP/fair-price settlements and missing quotes were excluded by the original collector.', 'ROI uses the original unrounded fee approximation, not cent-rounded order fees.', 'No reliable out-of-sample advantage established. This does not test actual Kalshi combo quotes.'],
}, null, 2))
