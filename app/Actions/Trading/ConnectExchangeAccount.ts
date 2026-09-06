import type { VenueCredentials } from '../../Services/trading/credentials'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { requestBoolean, requestString } from '../../Support/request-input'
import { response } from '@stacksjs/router'
import { assertUsable, CredentialError, maskIdentifier, sealCredentials } from '../../Services/trading/credentials'
import { syncAccounts } from '../../Services/trading/account-sync'
import { clientFor } from '../../Services/trading/execute'
import { jurisdictionObjection } from '../../Services/trading/eligibility'

/**
 * POST /api/trading/accounts — connect a venue account.
 *
 * The credentials are proved before they are trusted: we seal them, read
 * a balance with them, and only then mark the account active. A key that
 * was pasted wrong should fail here, in a form, rather than at 4am
 * inside a trading pass where it looks like the strategy found nothing.
 *
 * Nothing in the response echoes a credential back, including on the
 * error path — a validation message that quotes the value it rejected
 * puts a private key in a browser history.
 */
export default {
  name: 'ConnectExchangeAccount',
  description: 'Store venue API credentials and verify them against the venue.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to connect a trading account.', 401)

    const venue = requestString(request, 'venue').toLowerCase()
    if (venue !== 'kalshi' && venue !== 'polymarket')
      return response.error(`Unknown venue: ${venue || '(missing)'}. Expected kalshi or polymarket.`, 422)

    if (!requestBoolean(request, 'termsAccepted') || !requestBoolean(request, 'riskAccepted') || !requestBoolean(request, 'ageConfirmed')) {
      return response.error(
        'You must accept the Terms, acknowledge the risk disclosure, and confirm you meet the venue age requirement before connecting an account.',
        422,
      )
    }

    const jurisdiction = requestString(request, 'jurisdiction').trim().toUpperCase()
    if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction))
      return response.error('Enter your country code (for example US or CA-BC).', 422)

    const jurisdictionError = jurisdictionObjection(venue, jurisdiction)
    if (jurisdictionError)
      return response.error(jurisdictionError, 451)

    const credentials: VenueCredentials = venue === 'kalshi'
      ? {
          venue: 'kalshi',
          apiKeyId: requestString(request, 'apiKeyId'),
          privateKeyPem: requestString(request, 'privateKeyPem'),
          subaccount: optionalInteger(requestString(request, 'subaccount')),
        }
      : {
          venue: 'polymarket',
          apiKey: requestString(request, 'apiKey'),
          apiSecret: requestString(request, 'apiSecret'),
          apiPassphrase: requestString(request, 'apiPassphrase'),
          privateKey: requestString(request, 'privateKey'),
          funderAddress: requestString(request, 'funderAddress'),
          signatureType: optionalSignatureType(requestString(request, 'signatureType')),
        }

    try {
      assertUsable(credentials)
    }
    catch (error) {
      return response.error(error instanceof CredentialError ? error.message : 'Invalid credentials.', 422)
    }

    const sealed = await sealCredentials(credentials)
    const label = requestString(request, 'label', 'Primary').slice(0, 60)
    const masked = maskIdentifier(credentials)
    const now = new Date().toISOString()

    // Verify before storing anything as usable: an account row that says
    // 'active' without a successful read is a promise we have not kept.
    let balance = 0
    try {
      const client = await clientFor(sealed)
      balance = (await client.fetchBalance()).available
    }
    catch (error) {
      return response.error(
        `${venue} rejected these credentials: ${error instanceof Error ? error.message : String(error)}`,
        422,
      )
    }

    const db = new Database()

    try {
      await db.updateOrInsert('exchange_accounts', { user_id: userId, venue }, {
        label,
        credentials: sealed,
        masked_identifier: masked,
        status: 'active',
        balance,
        last_error: '',
        last_synced_at: now,
        terms_accepted_at: now,
        risk_accepted_at: now,
        age_confirmed_at: now,
        jurisdiction,
        updated_at: now,
      })

      /*
       * Mirror the account before answering.
       *
       * Connecting is the moment a user goes looking for their positions,
       * and without this the portfolio page greets them with an empty
       * book until its next refresh — which reads, correctly enough, as
       * the connection not having worked. Best effort: the credentials
       * are already proved by the balance read above, so a slow position
       * endpoint must not turn a successful connection into an error.
       */
      const mirrored = await syncAccounts(db, { userId })
        .then(summary => summary.synced > 0)
        .catch(() => false)

      return {
        venue,
        label,
        maskedIdentifier: masked,
        status: 'active',
        balance,
        mirrored,
      }
    }
    finally {
      db.close()
    }
  },
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim())
    return undefined
  return Number(value)
}

function optionalSignatureType(value: string | undefined): 0 | 1 | 2 | 3 | undefined {
  if (!value?.trim())
    return undefined
  return Number(value) as 0 | 1 | 2 | 3
}
