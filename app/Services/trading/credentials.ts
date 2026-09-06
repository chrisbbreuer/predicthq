import { decrypt, encrypt } from '@stacksjs/security'

/**
 * Venue credentials, sealed.
 *
 * A trading key is not a password we can hash — it has to come back out
 * to sign a request — so it is encrypted with the app key and stored as
 * one opaque blob. Keeping every read and write in this file means there
 * is a single place to audit for "where can a private key be in the
 * clear", and it is short enough to audit.
 *
 * Nothing here logs. A thrown error carries the shape of the failure, not
 * the value that failed, because credential errors are exactly the ones
 * that end up in a log aggregator.
 */

/**
 * Kalshi signs each request with an RSA key registered against an API
 * key id. The PEM is the private half — it never leaves this process.
 */
export interface KalshiCredentials {
  venue: 'kalshi'
  apiKeyId: string
  privateKeyPem: string
  /** 0 is the primary account; 1-32 isolates a dedicated trading bankroll. */
  subaccount?: number
}

/**
 * Polymarket's CLOB uses an API key trio for transport auth (L2) plus
 * the wallet key that signs the order itself (L1). Both are required to
 * trade; the API trio alone can only read.
 */
export interface PolymarketCredentials {
  venue: 'polymarket'
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  /** 0x-prefixed secp256k1 key for the trading wallet. */
  privateKey: string
  /** Proxy wallet the orders are attributed to. */
  funderAddress: string
  /** EOA=0, proxy=1, Safe=2, EIP-1271 contract=3. */
  signatureType?: 0 | 1 | 2 | 3
}

export type VenueCredentials = KalshiCredentials | PolymarketCredentials

export class CredentialError extends Error {}

/** Seal credentials for storage. */
export async function sealCredentials(credentials: VenueCredentials, passphrase?: string): Promise<string> {
  return await encrypt(JSON.stringify(credentials), passphrase)
}

/**
 * Open a stored envelope.
 *
 * A failure here is almost always a rotated APP_KEY rather than a corrupt
 * row, so the message says so: the alternative is a caller reporting
 * "the venue rejected us" when we never reached the venue.
 */
export async function openCredentials(sealed: string, passphrase?: string): Promise<VenueCredentials> {
  if (!sealed)
    throw new CredentialError('No credentials stored for this account.')

  let plain: string
  try {
    plain = await decrypt(sealed, passphrase)
  }
  catch {
    throw new CredentialError('Stored credentials could not be decrypted — APP_KEY may have changed since they were saved. Reconnect the account.')
  }

  try {
    return JSON.parse(plain) as VenueCredentials
  }
  catch {
    throw new CredentialError('Stored credentials are not in the expected format. Reconnect the account.')
  }
}

/**
 * What we can show about a credential without exposing it. Last four of
 * the identifier is enough to tell two connected accounts apart, and is
 * what the venues themselves display.
 */
export function maskIdentifier(credentials: VenueCredentials): string {
  const identifier = credentials.venue === 'kalshi'
    ? credentials.apiKeyId
    : credentials.funderAddress

  return identifier.length <= 4 ? '…' : `…${identifier.slice(-4)}`
}

/**
 * Reject a credential set that cannot possibly work before it is stored.
 *
 * Catching a missing field here turns a confusing venue rejection at
 * 3am into a form error at connect time.
 */
export function assertUsable(credentials: VenueCredentials): void {
  const missing: string[] = []

  if (credentials.venue === 'kalshi') {
    if (!credentials.apiKeyId.trim())
      missing.push('apiKeyId')
    if (!credentials.privateKeyPem.includes('PRIVATE KEY'))
      missing.push('privateKeyPem (expected a PEM block)')
    if (credentials.subaccount !== undefined && (!Number.isInteger(credentials.subaccount) || credentials.subaccount < 0 || credentials.subaccount > 32))
      missing.push('subaccount (expected an integer from 0 to 32)')
  }
  else {
    if (!credentials.apiKey.trim())
      missing.push('apiKey')
    if (!credentials.apiSecret.trim())
      missing.push('apiSecret')
    if (!credentials.apiPassphrase.trim())
      missing.push('apiPassphrase')
    if (!/^0x[0-9a-f]{64}$/i.test(credentials.privateKey))
      missing.push('privateKey (expected 0x + 64 hex characters)')
    if (!/^0x[0-9a-f]{40}$/i.test(credentials.funderAddress))
      missing.push('funderAddress (expected a 0x address)')
    if (credentials.signatureType !== undefined && ![0, 1, 2, 3].includes(credentials.signatureType))
      missing.push('signatureType (expected 0, 1, 2, or 3)')
  }

  if (missing.length > 0)
    throw new CredentialError(`Incomplete ${credentials.venue} credentials: ${missing.join(', ')}.`)
}
