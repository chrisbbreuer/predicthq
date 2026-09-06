import { describe, expect, it } from 'bun:test'
import { openCredentials, sealCredentials } from '../../app/Services/trading/credentials'

describe('venue credential envelopes', () => {
  it('round-trips Kalshi credentials without leaving identifiers or key material in storage', async () => {
    const passphrase = 'test-only-credential-envelope-key'
    const credentials = {
      venue: 'kalshi' as const,
      apiKeyId: '00000000-1111-2222-3333-444444444444',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest-only-material\n-----END PRIVATE KEY-----',
      subaccount: 0,
    }

    const sealed = await sealCredentials(credentials, passphrase)

    expect(sealed).not.toContain(credentials.apiKeyId)
    expect(sealed).not.toContain('test-only-material')
    expect(await openCredentials(sealed, passphrase)).toEqual(credentials)
  })
})
