import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { log } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { Database } from '../Support/db'
import type { BacktestReport } from '../Services/trading/backtest'
import { backtestGames, summarizeBets, summarizeConsensus } from '../Services/trading/backtest'
import { haltState, setHalt } from '../Services/trading/halt'
import { linesReport, liveLines } from '../Services/trading/line-snapshots'
import { auditRecordedCheckpoints, MIN_PAIRED_CHECKPOINTS } from '../Services/trading/prediction-checkpoints'
import { draftSlate, explicitPicks, MIN_PARLAY_PAYOUT, parlayExpectedReturn, placeSlate } from '../Services/trading/slate'
import { generateSuggestions, saveSuggestions } from '../Services/trading/suggestions'

/**
 * `buddy trading:halt` — stop every strategy from placing orders.
 *
 * The switch exists to be thrown under pressure, so it is one command
 * with no arguments beyond the reason, it takes effect on every process
 * without a redeploy, and it says plainly what it did. Resuming is a
 * separate command rather than a flag: nobody types the wrong one of two
 * words as fast as they mistype a flag.
 *
 * A deployment-level `TRADING_ENABLED=false` outranks both, and
 * `trading:status` says so rather than letting a resume look like it
 * worked when the environment still refuses.
 */
export default function (cli: CLI) {
  cli
    .command('trading:halt', 'Stop all automated order placement')
    .option('--reason <reason>', 'Why trading is being stopped', { default: '' })
    .option('--actor <actor>', 'Who is stopping it', { default: 'operator' })
    .action(async (options: { reason?: string, actor?: string }) => {
      const db = new Database()

      try {
        await setHalt(db, {
          halted: true,
          reason: options.reason || 'halted from the command line',
          actor: options.actor || 'operator',
        })

        log.success('Trading is halted. No strategy will place an order until it is resumed.')
        log.info('Decisions are still recorded, so the engine\'s reasoning stays visible while it is stopped.')
      }
      catch (error) {
        log.error(`Could not halt trading: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
      finally {
        db.close()
      }
    })

  cli
    .command('trading:resume', 'Allow automated order placement again')
    .option('--actor <actor>', 'Who is resuming it', { default: 'operator' })
    .action(async (options: { actor?: string }) => {
      const db = new Database()

      try {
        await setHalt(db, {
          halted: false,
          reason: 'resumed from the command line',
          actor: options.actor || 'operator',
        })

        const state = await haltState(db)
        if (state.halted) {
          log.warn(`The halt log is clear, but trading is still stopped: ${state.reason}`)
          return
        }

        log.success('Trading is live. Strategies will place orders on their next pass.')
      }
      catch (error) {
        log.error(`Could not resume trading: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
      finally {
        db.close()
      }
    })

  cli
    .command('trading:status', 'Report whether automated trading is live')
    .action(async () => {
      const db = new Database()

      try {
        const state = await haltState(db)

        if (!state.halted) {
          log.success('Trading is live.')
          return
        }

        log.warn(`Trading is halted: ${state.reason}`)
        if (state.actor)
          log.info(`Stopped by ${state.actor}${state.since ? ` at ${state.since}` : ''}.`)
      }
      finally {
        db.close()
      }
    })

  /**
   * `buddy trading:backtest --date 20261116` - replay a finished day of
   * games and score each strategy against how they ended, using only what
   * was knowable at each checkpoint. Reads only; never places an order.
   */
  cli
    .command('trading:backtest', 'Replay a finished day of games and score each strategy')
    .option('--date <date>', 'Eastern date of the games, YYYYMMDD (default: yesterday)', { default: '' })
    .option('--stake <stake>', 'Dollars per bet', { default: '1' })
    .option('--bankroll <bankroll>', 'Starting bankroll for the sequential simulation', { default: '10' })
    .option('--min-edge <edge>', 'Minimum model edge in probability points', { default: '0.03' })
    .option('--days <n>', 'Replay this many days ending on --date and combine them', { default: '1' })
    .option('--max-events <n>', 'Cap on games replayed per day', { default: '400' })
    .option('--series <list>', 'Comma-separated Kalshi series (for example KXNBAGAME)', { default: '' })
    .option('--consensus', 'Compare against independent pre-game sportsbook history', { default: false })
    .option('--json <path>', 'Also write the full report, every bet included, to this file', { default: '' })
    .action(async (options: { date?: string, days?: string, stake?: string, bankroll?: string, minEdge?: string, maxEvents?: string, json?: string, series?: string, consensus?: boolean }) => {
      const consensusDb = options.consensus ? new Database() : undefined
      try {
        const date = options.date || yesterdayEastern()
        if (!/^\d{8}$/.test(date))
          throw new Error('--date must be YYYYMMDD')
        const bankroll = Number(options.bankroll) || 10
        const days = Math.max(1, Math.min(30, Number(options.days) || 1))
        const series = options.series?.split(',').map(value => value.trim().toUpperCase()).filter(Boolean)
        const reports: BacktestReport[] = []
        for (let back = days - 1; back >= 0; back--) {
          const day = shiftDate(date, -back)
          const report = await backtestGames({
            date: day,
            consensusDb,
            series: series?.length ? series : undefined,
            stake: Number(options.stake) || 1,
            bankroll,
            minEdge: Number(options.minEdge) || 0.03,
            maxEvents: Number(options.maxEvents) || 400,
          })
          reports.push(report)
          printBacktest(report)
        }
        if (reports.length > 1) {
          const bets = reports.flatMap(report => report.bets)
          const views = reports.reduce((sum, report) => sum + report.brier.modelViews, 0)
          const weigh = (key: 'market' | 'model') => {
            let total = 0
            let count = 0
            for (const report of reports) {
              if (report.brier[key] !== null) {
                total += report.brier[key]! * report.checkpoints
                count += report.checkpoints
              }
            }
            return count ? Math.round((total / count) * 10000) / 10000 : null
          }
          const consensusViews = reports.flatMap(report => report.consensusViews)
          printBacktest({
            consensus: options.consensus ? summarizeConsensus(consensusViews) : undefined,
            consensusViews,
            date: `${reports[0]!.date}-${reports.at(-1)!.date}`,
            events: reports.reduce((sum, report) => sum + report.events, 0),
            checkpoints: reports.reduce((sum, report) => sum + report.checkpoints, 0),
            brier: { market: weigh('market'), model: weigh('model'), modelViews: views },
            strategies: summarizeBets(bets, bankroll),
            bets,
            views: reports.flatMap(report => report.views),
            skipped: {},
          })
        }
        const report = reports.length === 1 ? reports[0] : reports
        if (options.json)
          await Bun.write(options.json, JSON.stringify(report, null, 2))
      }
      catch (error) {
        log.error(`Backtest failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
      finally {
        consensusDb?.close()
      }
    })


  cli
    .command('trading:prediction-audit', 'Review ranked winner picks and settled T-30 forecasts')
    .action(async () => {
      const db = new Database()
      try {
        const report = await auditRecordedCheckpoints(db)
        log.info(`${report.capturedGames} captured games, ${report.settled} settled, ${report.pairedSettled}/${MIN_PAIRED_CHECKPOINTS} paired settlements for the scheduled review`)
        console.log(JSON.stringify(report, null, 2))
      }
      finally {
        db.close()
      }
    })

  cli
    .command('trading:lines', 'Score Kalshi against the recorded sportsbook lines, game by game')
    .option('--gap <gap>', 'Minimum disagreement, in probability points, before buying', { default: '0.02' })
    .action(async (options: { gap?: string }) => {
      const db = new Database()
      try {
        const report = await linesReport(db, { gap: Number(options.gap) || 0.02 })
        log.info(`${report.games} games recorded, ${report.settled} settled`)
        log.info(`Brier: Kalshi ${report.brier.kalshi ?? '-'} · book ${report.brier.book ?? '-'} (lower is better)`)
        const won = report.bets.filter(bet => bet.won).length
        const pnl = report.bets.reduce((sum, bet) => sum + bet.pnl, 0)
        log.info(`Bets at a ${report.gap} gap: ${report.bets.length} (${won} won) · P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} on $1 stakes · ROI ${report.roi === null ? '-' : `${(report.roi * 100).toFixed(1)}%`} · ${report.daysUp}/${report.days} days up`)
      }
      finally {
        db.close()
      }
    })

  cli
    .command('trading:slate', 'Build a day of paper bets, singles and two-leg parlays, where the book disagrees with Kalshi')
    .option('--budget <dollars>', 'Total to stake across the slate', { default: '5' })
    .option('--stake <dollars>', 'Dollars per single or parlay', { default: '1' })
    .option('--singles <n>', 'How many singles before parlays', { default: '3' })
    .option('--min-gap <points>', 'Minimum book-vs-Kalshi disagreement', { default: '0.02' })
    .option('--hours <n>', 'Only games starting within this many hours', { default: '12' })
    .option('--user <id>', 'Account the paper bets belong to', { default: '1' })
    .option('--dry-run', 'Show the slate without recording it', { default: false })
    .option('--strategy <id>', 'Add to an existing slate strategy instead of starting one', { default: '' })
    .option('--tickers <list>', 'Only these markets, as singles (comma-separated tickers)', { default: '' })
    .action(async (options: { budget?: string, stake?: string, singles?: string, minGap?: string, hours?: string, user?: string, dryRun?: boolean, strategy?: string, tickers?: string }) => {
      const stake = Number(options.stake) || 1
      const drafted = await draftSlate({
        budget: Number(options.budget) || 5,
        stake,
        singles: Number(options.singles) || 3,
        minGap: Number(options.minGap) || 0.02,
        windowMinutes: (Number(options.hours) || 12) * 60,
      })
      const { picks, lines } = drafted
      const only = new Set(String(options.tickers || '').split(',').map(ticker => ticker.trim()).filter(Boolean))
      const slate = only.size > 0
        ? { singles: picks.filter(pick => only.has(pick.line.ticker)), parlays: [] }
        : drafted.slate
      const pctOf = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
      log.info(`${lines} Kalshi game markets with a book line; ${picks.length} games where the book disagrees enough; ${picks.filter(pick => pick.ev > 0).length} worth more than they cost if the book is right`)
      for (const pick of slate.singles)
        log.info(`  single  $${stake}  ${pick.label} at ${Math.round(pick.price * 100)}¢  book ${(pick.fair * 100).toFixed(1)}%  expected ${pctOf(pick.ev)}`)
      for (const legs of slate.parlays)
        log.info(`  parlay  $${stake}  ${legs.map(pick => `${pick.label} ${Math.round(pick.price * 100)}¢`).join('  +  ')}  pays $${(stake / legs.reduce((product, pick) => product * pick.price, 1)).toFixed(2)}  expected ${pctOf(parlayExpectedReturn(legs))}`)
      if (options.dryRun || slate.singles.length + slate.parlays.length === 0)
        return
      const db = new Database()
      try {
        const name = `Paper slate ${new Date().toISOString().slice(0, 10)}`
        const placed = await placeSlate(db, slate, { userId: Number(options.user) || 1, stake, name, strategyId: Number(options.strategy) || undefined })
        for (const single of placed.singles)
          log.info(`  ${single.placed ? 'recorded' : 'skipped'}: ${single.label}${single.reason ? ` (${single.reason})` : ''}`)
        log.success(`Recorded under "${name}" (strategy ${placed.strategyId}): ${placed.singles.filter(single => single.placed).length} singles, ${placed.parlays.length} parlays. Paper only: no money moves.`)
      }
      finally {
        db.close()
      }
    })

  cli
    .command('trading:suggest', 'Suggest bets on the bets page for approval: the automatic picks, or specific markets')
    .option('--user <id>', 'Account to suggest to', { default: '1' })
    .option('--auto', 'Run the same picks the ten-minute job makes', { default: false })
    .option('--singles <list>', 'Singles, as TICKER:side, comma-separated', { default: '' })
    .option('--parlays <list>', 'Parlays, legs joined with + and parlays separated by ;', { default: '' })
    .option('--stake <dollars>', 'Dollars per suggestion', { default: '1' })
    .action(async (options: { user?: string, auto?: boolean, singles?: string, parlays?: string, stake?: string }) => {
      const userId = Number(options.user) || 1
      const stake = Number(options.stake) || 1
      const db = new Database()
      try {
        const lines = await liveLines(undefined, 36 * 60, { includeLive: true })
        let saved = 0
        if (options.auto)
          saved += await generateSuggestions(db, userId, { lines, stake })
        const bets: Array<{ kind: 'single' | 'parlay', picks: ReturnType<typeof explicitPicks>, stake: number }> = []
        for (const spec of String(options.singles || '').split(',').map(part => part.trim()).filter(Boolean)) {
          const picks = explicitPicks(lines, [spec])
          if (picks.length === 0)
            log.warn(`  skipped ${spec}: no live quote and line, or outside the 25–85¢ band`)
          else bets.push({ kind: 'single', picks, stake })
        }
        for (const group of String(options.parlays || '').split(';').map(part => part.trim()).filter(Boolean)) {
          const specs = group.split('+')
          const picks = explicitPicks(lines, specs)
          if (picks.length !== specs.length || new Set(picks.map(pick => pick.line.gameId)).size !== picks.length) {
            log.warn(`  skipped parlay ${group}: every leg needs a quote, and legs must be different games`)
            continue
          }
          const payout = 1 / picks.reduce((product, pick) => product * pick.price, 1)
          if (payout < MIN_PARLAY_PAYOUT)
            log.warn(`  parlay ${group} pays only ${payout.toFixed(2)}x, under the ${MIN_PARLAY_PAYOUT}x the automatic parlays aim for; kept because you named it`)
          bets.push({ kind: 'parlay', picks, stake })
        }
        for (const bet of bets)
          log.info(`  ${bet.kind}  ${bet.picks.map(pick => `${pick.label} ${Math.round(pick.price * 100)}¢`).join('  +  ')}  expected ${((bet.kind === 'single' ? bet.picks[0]!.ev : parlayExpectedReturn(bet.picks)) * 100).toFixed(1)}%`)
        saved += await saveSuggestions(db, userId, bets)
        log.success(`${saved} new suggestion${saved === 1 ? '' : 's'} on the bets page, waiting for approval.`)
      }
      finally {
        db.close()
      }
    })
}

/** Yesterday's date in US Eastern, `YYYYMMDD`. */
function yesterdayEastern(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() - 86_400_000))
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}${get('month')}${get('day')}`
}

function shiftDate(yyyymmdd: string, days: number): string {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + days))
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function printBacktest(report: BacktestReport): void {
  log.info(`Backtest ${report.date}: ${report.events} games, ${report.checkpoints} checkpoints`)
  log.info(`  Brier (lower is better): market ${report.brier.market ?? '-'}, model ${report.brier.model ?? '-'} (model had a view at ${report.brier.modelViews})`)
  if (report.consensus) {
    const { sampleSize, market, sportsbook, blend } = report.consensus
    const score = (value: number | null) => value?.toFixed(5) ?? '-'
    log.info(`  Paired T-30 forecasts: ${sampleSize} games (at least two sportsbooks, exchanges excluded)`)
    log.info(`  Brier: Kalshi ${score(market.brier)}, books ${score(sportsbook.brier)}, 50/50 blend ${score(blend.brier)}`)
    log.info(`  Log loss: Kalshi ${score(market.logLoss)}, books ${score(sportsbook.logLoss)}, 50/50 blend ${score(blend.logLoss)}`)
  }
  for (const result of report.strategies) {
    const roi = result.roi === null ? '-' : `${(result.roi * 100).toFixed(1)}%`
    const pnl = `${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(2)}`
    log.info(`  ${result.strategy.padEnd(10)} ${String(result.bets).padStart(4)} bets ${String(result.wins).padStart(4)} won  staked ${result.staked.toFixed(2)}  fees ${result.fees.toFixed(2)}  P&L ${pnl}  ROI ${roi}  bankroll ends ${result.endingBankroll.toFixed(2)}`)
  }
  if (Object.keys(report.skipped).length)
    log.info(`  Skipped: ${Object.entries(report.skipped).map(([reason, count]) => `${reason} ${count}`).join(', ')}`)
}
