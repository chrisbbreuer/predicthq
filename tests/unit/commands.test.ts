import { describe, expect, it } from 'bun:test'
import commands from '../../app/Commands'
import { evaluateChecks, invalidProductionValues, isBroken } from '../../app/Commands/Preflight'

describe('production commands', () => {
  it('registers the resumable database import and Transfermarkt backfill', () => {
    expect(commands['database:import-legacy']).toBe('ImportLegacyDatabase')
    expect(commands['transfermarkt:backfill']).toBe('TransfermarktBackfill')
  })
})

describe('production preflight', () => {
  it('requires the Google redirect URL with the OAuth credentials', () => {
    const google = evaluateChecks({
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    }).find(result => result.check.key === 'GOOGLE_CLIENT_ID')

    expect(google).toBeDefined()
    expect(isBroken(google!)).toBe(true)
    expect(google?.missingCompanions).toContain('GOOGLE_REDIRECT_URL')
  })

  it('requires https and a tester allowlist before a controlled live test', () => {
    const failures = invalidProductionValues({
      APP_URL: 'http://predicthq.org',
      TRADING_ENABLED: 'true',
      PUBLIC_LIVE_TRADING_ENABLED: 'false',
      TRADING_BANKROLL_CAP_USD: '20',
      ODDS_FALLBACK_MIN_INTERVAL_MS: '1000',
    })
    expect(failures).toContain('APP_URL must use https:// in production')
    expect(failures).toContain('LIVE_TRADING_USER_ALLOWLIST is required for a controlled live test')
    expect(failures).toContain('ODDS_FALLBACK_MIN_INTERVAL_MS must be at least 60000')
  })

  it('accepts the fail-closed launch values', () => {
    expect(invalidProductionValues({
      APP_URL: 'https://predicthq.org',
      TRADING_ENABLED: 'false',
      PUBLIC_LIVE_TRADING_ENABLED: 'false',
      TRADING_BANKROLL_CAP_USD: '20',
      ODDS_FALLBACK_MIN_INTERVAL_MS: '300000',
    })).toEqual([])
  })
})
