import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { log } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { allAdapters, booksWithoutAdapters } from '../Services/odds/books'
import { auditVitessMigrations, keyspaceIsSharded } from '../Services/schema'

/**
 * `buddy preflight` — what will this deployment actually be able to do?
 *
 * Every one of these is optional in the sense that the app boots without
 * it, and that is the problem. A production deploy with no `ODDS_API_KEY`
 * comes up serving a simulator, with no sign-in provider it comes up with
 * a login page nobody can use, and both look exactly like a healthy boot
 * in the logs. The failure surfaces days later as "why does the board
 * never move", which is a bad way to find out.
 *
 * Run before cutting over, and again after. Exits non-zero when something
 * required for the target environment is missing, so a deploy script can
 * gate on it.
 */

interface Check {
  key: string
  label: string
  /** What silently degrades when this is absent. */
  consequence: string
  /** Required in production. Absent elsewhere is normal. */
  requiredInProduction: boolean
  /** Extra keys that must all be present for the feature to work. */
  companions?: string[]
}

const CHECKS: Check[] = [
  {
    key: 'APP_KEY',
    label: 'Application key',
    consequence: 'Encryption and signed values are unsafe without it.',
    requiredInProduction: true,
  },
  {
    key: 'APP_URL',
    label: 'Canonical application URL',
    consequence: 'OAuth callbacks, checkout redirects, and absolute links can point at the wrong host.',
    requiredInProduction: true,
  },
  {
    key: 'ODDS_API_KEY',
    label: 'Live odds feed',
    consequence: 'Every price falls back to the built-in simulator, and every edge on the site is fictional.',
    requiredInProduction: true,
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'AI review',
    consequence: 'Candidates are never reviewed, so decisions carry no written reasoning.',
    requiredInProduction: true,
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    label: 'Google sign-in',
    consequence: 'The button is hidden and nobody can create an account with Google.',
    requiredInProduction: true,
    companions: ['GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URL'],
  },
  {
    key: 'APPLE_CLIENT_ID',
    label: 'Apple sign-in',
    consequence: 'The button is hidden and nobody can create an account with Apple.',
    requiredInProduction: false,
    companions: ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
  },
  {
    key: 'STRIPE_SECRET_KEY',
    label: 'Stripe subscriptions',
    consequence: 'Paid checkout and signed entitlement updates cannot work.',
    requiredInProduction: true,
    companions: ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
  },
  {
    key: 'TRADING_ENABLED',
    label: 'Trading deployment switch',
    consequence: 'Production trading must be explicitly set to true or false; an absent switch fails closed.',
    requiredInProduction: true,
  },
  {
    key: 'TRADING_BANKROLL_CAP_USD',
    label: 'Live bankroll cap',
    consequence: 'There is no deployment-level ceiling above individual strategy settings.',
    requiredInProduction: true,
  },
]

interface Result {
  check: Check
  present: boolean
  /** Keys the feature needs that are missing, when partially configured. */
  missingCompanions: string[]
}

export function evaluateChecks(env: Record<string, string | undefined> = process.env): Result[] {
  return CHECKS.map((check) => {
    const present = Boolean(env[check.key])
    const missingCompanions = present
      ? (check.companions ?? []).filter(key => !env[key])
      : []

    return { check, present, missingCompanions }
  })
}

/** A half-configured provider is worse than an absent one: it looks done. */
export function isBroken(result: Result): boolean {
  return result.present && result.missingCompanions.length > 0
}

export function failures(results: Result[], isProduction: boolean): Result[] {
  return results.filter(r => isBroken(r) || (isProduction && r.check.requiredInProduction && !r.present))
}

export function invalidProductionValues(env: Record<string, string | undefined> = process.env): string[] {
  const invalid: string[] = []
  if (env.TRADING_ENABLED && !['true', 'false', '1', '0'].includes(env.TRADING_ENABLED.toLowerCase()))
    invalid.push('TRADING_ENABLED must be true or false')

  const cap = Number(env.TRADING_BANKROLL_CAP_USD)
  if (env.TRADING_BANKROLL_CAP_USD && (!Number.isFinite(cap) || cap <= 0))
    invalid.push('TRADING_BANKROLL_CAP_USD must be a positive number')

  const fallbackInterval = Number(env.ODDS_FALLBACK_MIN_INTERVAL_MS)
  if (env.ODDS_FALLBACK_MIN_INTERVAL_MS && (!Number.isFinite(fallbackInterval) || fallbackInterval < 60_000))
    invalid.push('ODDS_FALLBACK_MIN_INTERVAL_MS must be at least 60000')

  if (env.APP_URL && !/^https:\/\//.test(env.APP_URL))
    invalid.push('APP_URL must use https:// in production')

  const liveEnabled = ['true', '1'].includes((env.TRADING_ENABLED ?? '').toLowerCase())
  const publicLive = ['true', '1'].includes((env.PUBLIC_LIVE_TRADING_ENABLED ?? '').toLowerCase())
  if (liveEnabled && !publicLive && !(env.LIVE_TRADING_USER_ALLOWLIST ?? '').trim())
    invalid.push('LIVE_TRADING_USER_ALLOWLIST is required for a controlled live test')

  return invalid
}

export default function (cli: CLI) {
  cli
    .command('preflight', 'Report what this deployment can actually do')
    .option('--production, -p', 'Treat missing production requirements as failures', { default: false })
    .action((options: { production?: boolean }) => {
      const appEnv = process.env.APP_ENV ?? 'local'
      const isProduction = options.production || appEnv === 'production'
      const results = evaluateChecks()
      const invalidValues = isProduction ? invalidProductionValues() : []

      console.log(`\n  Preflight — ${appEnv}\n`)

      for (const result of results) {
        const { check } = result
        if (isBroken(result)) {
          console.log(`  ✗ ${check.label} is half configured`)
          console.log(`     ${check.key} is set but ${result.missingCompanions.join(', ')} ${result.missingCompanions.length === 1 ? 'is' : 'are'} not.`)
          continue
        }

        if (result.present) {
          console.log(`  ✓ ${check.label}`)
          continue
        }

        const required = isProduction && check.requiredInProduction
        console.log(`  ${required ? '✗' : '·'} ${check.label} is not configured`)
        console.log(`     ${check.consequence}`)
        console.log(`     Set ${[check.key, ...(check.companions ?? [])].join(', ')}.`)
      }

      // The schema half of the same question. An env key that is missing
      // announces itself the first time a feature is used; a table that
      // cannot allocate an id announces itself the first time someone
      // writes to it, which on this deployment means mid-trade.
      // The native feed. An enabled book with no adapter behind it is
      // silently absent from the board, which looks exactly like a book
      // that had nothing to quote — and a deployment with no adapters at
      // all runs `odds:watch` as a process that can never poll anything.
      const adapters = allAdapters()
      const missingAdapters = booksWithoutAdapters()

      console.log('')
      if (adapters.length === 0) {
        console.log(`  ${isProduction ? '·' : '·'} No native book adapters are written yet`)
        console.log('     Every price comes from the fallback provider, or from the simulator.')
      }
      else {
        console.log(`  ✓ ${adapters.length} native book adapter${adapters.length === 1 ? '' : 's'}`)
      }

      if (missingAdapters.length > 0) {
        console.log(`  · ${missingAdapters.length} book${missingAdapters.length === 1 ? ' is' : 's are'} enabled with no adapter written`)
        console.log(`     ${missingAdapters.join(', ')}`)
        console.log('     These contribute nothing until an adapter exists, and their absence is indistinguishable from a quiet book.')
      }

      const sharded = keyspaceIsSharded()
      const schemaProblems = process.env.DB_CONNECTION === 'vitess' ? auditVitessMigrations() : []

      if (process.env.DB_CONNECTION === 'vitess') {
        console.log('')
        if (schemaProblems.length === 0) {
          console.log(`  ✓ Vitess migrations match a ${sharded ? 'sharded' : 'single unsharded'} keyspace`)
        }
        else {
          console.log(`  ✗ ${schemaProblems.length} Vitess ${schemaProblems.length === 1 ? 'table does' : 'tables do'} not match a ${sharded ? 'sharded' : 'single unsharded'} keyspace`)
          for (const problem of schemaProblems)
            console.log(`     ${problem.table} ${problem.detail}`)
        }
      }

      const failed = failures(results, isProduction)
      for (const problem of invalidValues)
        console.log(`  ✗ ${problem}`)
      console.log('')

      if (failed.length === 0 && schemaProblems.length === 0 && invalidValues.length === 0) {
        log.success(isProduction
          ? 'Ready for production.'
          : 'Nothing is broken. Unset keys above are optional outside production.')
        return
      }

      const total = failed.length + schemaProblems.length + invalidValues.length
      log.error(`${total} ${total === 1 ? 'problem' : 'problems'} would ship silently. Fix them or deploy knowingly.`)
      process.exit(ExitCode.FatalError)
    })
}
