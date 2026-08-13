import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'

export default {
  name: 'GetExchangeAccounts',
  description: 'List a user\'s connected venue accounts without credential material.',

  async handle(request?: { user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to view trading accounts.', 401)

    const db = new Database()
    try {
      const accounts = await db.prepare<{
        venue: string
        label: string
        masked_identifier: string
        status: string
        balance: number
        last_error: string
        last_synced_at: string
        jurisdiction: string
      }>(`
        SELECT venue, label, masked_identifier, status, balance, last_error,
          last_synced_at, jurisdiction
        FROM exchange_accounts
        WHERE user_id = ? AND status != 'disconnected'
        ORDER BY venue
      `).all(userId)

      return {
        count: accounts.length,
        accounts: accounts.map(account => ({
          venue: account.venue,
          label: account.label,
          maskedIdentifier: account.masked_identifier,
          status: account.status,
          balance: Number(account.balance),
          lastError: account.last_error,
          lastSyncedAt: account.last_synced_at,
          jurisdiction: account.jurisdiction,
        })),
      }
    }
    finally {
      db.close()
    }
  },
}
