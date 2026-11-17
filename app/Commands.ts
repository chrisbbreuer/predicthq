export interface CommandConfig {
  /** The command file name (without .ts extension) */
  file: string
  /** Whether the command is enabled */
  enabled?: boolean
  /** Command aliases */
  aliases?: string[]
}

export type CommandRegistry = Record<string, string | CommandConfig>

/**
 * The application's command registry.
 *
 * Commands listed here will be auto-loaded by the CLI.
 * You can use a simple string (file name) or a config object for more control.
 *
 * @example
 * // Simple registration
 * 'inspire': 'Inspire',
 *
 * // With config
 * 'send-emails': {
 *   file: 'SendEmails',
 *   enabled: true,
 *   aliases: ['emails', 'mail'],
 * },
 */
export default {
  'database:import-legacy': 'ImportLegacyDatabase',
  'inspire': 'Inspire',
  'transfermarkt:backfill': 'TransfermarktBackfill',

  // What this deployment can actually do. Run it before cutting over: the
  // app boots fine without an odds feed or a sign-in provider, and a boot
  // that looks healthy while serving a simulator is the failure mode this
  // is here to catch.
  'preflight': {
    file: 'Preflight',
    aliases: ['check'],
  },

  // The realtime price loop — the fourth runtime role, alongside web,
  // realtime, and scheduler. Cron's floor is one minute and a game in play
  // needs seconds, so this runs as its own long-lived process rather than
  // as a scheduled job. See app/Services/odds/engine.ts.
  'odds:watch': 'OddsWatch',

  // The global stop. Registered under three names because the file
  // defines three commands, and each has to be reachable on its own.
  'trading:halt': 'Trading',
  'trading:resume': 'Trading',
  'trading:status': 'Trading',
  'trading:backtest': 'Trading',
} satisfies CommandRegistry
