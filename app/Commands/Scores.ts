import type { CLI } from '@stacksjs/types'
import { importEspnFinals } from '../Services/ingest/espn'
import { captureGameBoxes, scoreLeagues } from '../Services/scores/box-history'
import { backtestScoreForecasts } from '../Services/scores/score-forecast'
import { Database } from '../Support/db'

export default function (cli: CLI) {
  cli
    .command('scores:backtest', 'Compare independent score forecasts with settled games')
    .option('--days <n>', 'Evaluate the last n days', { default: '90' })
    .option('--league <id>', 'League slug, or all', { default: 'all' })
    .action(async (options: { league?: string, days?: string }) => {
      const days = Number(options.days)
      const leagues = options.league === 'all' ? scoreLeagues : [options.league ?? 'nba']
      if (!Number.isInteger(days) || days < 1 || days > 365 || leagues.some(league => !scoreLeagues.includes(league)))
        throw new RangeError('Use a supported league and --days between 1 and 365')
      const db = new Database()
      try {
        console.log(JSON.stringify(await backtestScoreForecasts(db, leagues, days), null, 2))
      }
      finally {
        db.close()
      }
    })

  cli
    .command('scores:backfill <file>', 'Import dated ESPN scoreboard finals from a JSON lines archive')
    .action(async (file: string) => {
      const archive = (await Bun.file(file).text()).trim().split('\n').map(line => JSON.parse(line))
      const db = new Database()
      try {
        console.log(JSON.stringify(await importEspnFinals(db, archive)))
      }
      finally {
        db.close()
      }
    })

  cli
    .command('scores:collect-boxes', 'Archive a bounded batch of completed game box scores')
    .option('--league <id>', 'Limit the batch to this league')
    .action(async (options: { league?: string }) => {
      if (options.league && !scoreLeagues.includes(options.league))
        throw new RangeError('Unknown league')
      const db = new Database()
      try {
        console.log(JSON.stringify(await captureGameBoxes(db, 6, options.league)))
      }
      finally {
        db.close()
      }
    })
}
