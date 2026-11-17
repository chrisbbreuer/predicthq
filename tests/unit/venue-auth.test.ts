import { describe, expect, it } from 'bun:test'
import { rejectsCredentials, VenueError } from '../../app/Services/trading/venue'

/**
 * Revoking an account switches off its sync and its trading until the
 * user reconnects, so only a rejection of the key itself may do it. On 17
 * Nov 2026 a stale-timestamp 401 from Kalshi revoked a working account.
 */
describe('rejectsCredentials', () => {
  it('revokes on a key the venue rejects', () => {
    expect(rejectsCredentials(new VenueError('Kalshi GET /portfolio/balance failed (401): {"error":{"code":"unauthorized"}}', 'kalshi', 401, false))).toBe(true)
    expect(rejectsCredentials(new VenueError('forbidden', 'kalshi', 403, false))).toBe(true)
  })

  it('does not revoke on a stale signature timestamp', () => {
    const stale = 'Kalshi GET /portfolio/positions?limit=1000&count_filter=position failed (401): {"error":{"code":"header_timestamp_expired","message":"header timestamp expired"}}'
    expect(rejectsCredentials(new VenueError(stale, 'kalshi', 401, false))).toBe(false)
  })

  it('does not revoke on rate limits, outages or other errors', () => {
    expect(rejectsCredentials(new VenueError('slow down', 'kalshi', 429, true))).toBe(false)
    expect(rejectsCredentials(new VenueError('down', 'kalshi', 503, true))).toBe(false)
    expect(rejectsCredentials(new Error('network'))).toBe(false)
  })
})
