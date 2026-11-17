import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { log } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { Database } from '../Support/db'
import type { BacktestReport } from '../Services/trading/backtest'
import { backtestGames, summarizeBets } from '../Services/trading/backtest'
import { haltState, setHalt } from '../Services/trading/halt'

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
    .option('--json <path>', 'Also write the full report, every bet included, to this file', { default: '' })
    .action(async (options: { date?: string, days?: string, stake?: string, bankroll?: string, minEdge?: string, maxEvents?: string, json?: string }) => {
      const db = new Database()
      try {
        const date = options.date || yesterdayEastern()
        if (!/^\d{8}$/.test(date))
          throw new Error('--date must be YYYYMMDD')
        const bankroll = Number(options.bankroll) || 10
        const days = Math.max(1, Math.min(30, Number(options.days) || 1))
        const reports: BacktestReport[] = []
        for (let back = days - 1; back >= 0; back--) {
          const day = shiftDate(date, -back)
          const report = await backtestGames(db, {
            date: day,
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
          printBacktest({
            date: `${reports[0]!.date}-${reports.at(-1)!.date}`,
            events: reports.reduce((sum, report) => sum + report.events, 0),
            checkpoints: reports.reduce((sum, report) => sum + report.checkpoints, 0),
            brier: { market: weigh('market'), model: weigh('model'), modelViews: views },
            strategies: summarizeBets(bets, bankroll),
            bets,
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
  for (const result of report.strategies) {
    const roi = result.roi === null ? '-' : `${(result.roi * 100).toFixed(1)}%`
    const pnl = `${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(2)}`
    log.info(`  ${result.strategy.padEnd(10)} ${String(result.bets).padStart(4)} bets ${String(result.wins).padStart(4)} won  staked ${result.staked.toFixed(2)}  fees ${result.fees.toFixed(2)}  P&L ${pnl}  ROI ${roi}  bankroll ends ${result.endingBankroll.toFixed(2)}`)
  }
  if (Object.keys(report.skipped).length)
    log.info(`  Skipped: ${Object.entries(report.skipped).map(([reason, count]) => `${reason} ${count}`).join(', ')}`)
}
