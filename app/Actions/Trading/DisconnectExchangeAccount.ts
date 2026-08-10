import { Database } from '../../Support/db'
import { response } from '@stacksjs/router'

export default {
  name: 'DisconnectExchangeAccount',
  description: 'Erase stored venue credentials and disable the connection.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = request?.user?.id
    if (!userId)
      return response.error('Sign in to disconnect a trading account.', 401)

    const venue = (request?.get?.('venue') ?? '').toLowerCase()
    if (!['kalshi', 'polymarket'].includes(venue))
      return response.error('Expected kalshi or polymarket.', 422)

    const db = new Database()
    try {
      const result = await db.prepare(`
        UPDATE exchange_accounts
        SET credentials = '', status = 'disconnected', balance = 0,
          last_error = '', updated_at = ?
        WHERE user_id = ? AND venue = ?
      `).run(new Date().toISOString(), userId, venue)

      if (result.changes === 0)
        return response.error('Trading account not found.', 404)

      return { venue, disconnected: true }
    }
    finally {
      db.close()
    }
  },
}
