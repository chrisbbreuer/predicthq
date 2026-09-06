import { Database } from '../../Support/db'
import { log } from '@stacksjs/logging'
import { syncAccounts } from '../../Services/trading/account-sync'
import { syncOrders } from '../../Services/trading/sync'

/**
 * One reconciliation pass over every open order, then over every account.
 *
 * Runs far more often than the trading loop that creates the orders.
 * Placement is deliberate and slow; a fill is not, and every number a
 * user sees — exposure, position count, what the daily loss limit has
 * to work with — is stale until this has run.
 *
 * The account pass follows rather than replaces it. Reconciliation is
 * what makes our own book true, and nothing about the venue's mirror can
 * substitute for it: a mirror has no cost basis and no strategy, so it
 * cannot settle, cannot be attributed, and must never authorize an
 * order. What the mirror adds is the rest of the account — the balance,
 * and the positions and resting orders the user placed themselves —
 * which is what the portfolio page reads.
 *
 * Ordering matters in one direction only: an order that just filled
 * should be booked into our positions before we ask the venue what it
 * holds, so the two agree on the same pass rather than a minute apart.
 */
export default {
  name: 'SyncOrders',
  description: 'Reconcile open exchange orders against the venue, then mirror what each account holds.',

  async handle() {
    const db = new Database()

    try {
      const summary = await syncOrders(db)

      if (summary.examined > 0) {
        log.info(`[trading] reconciled ${summary.examined} orders · ${summary.advanced} advanced · ${summary.recovered} recovered · ${summary.expired} expired · ${summary.unreachable} unreachable`)
      }

      // Isolated from the summary above: a venue that will not answer a
      // portfolio read has not invalidated the order reconciliation that
      // already succeeded, and the caller should still hear about it.
      const accounts = await syncAccounts(db).catch((error) => {
        log.warn(`[trading] account sync failed: ${error instanceof Error ? error.message : String(error)}`)
        return { synced: 0, positions: 0, orders: 0, unreachable: 0 }
      })

      if (accounts.synced > 0 || accounts.unreachable > 0) {
        log.info(`[trading] mirrored ${accounts.synced} accounts · ${accounts.positions} positions · ${accounts.orders} resting orders · ${accounts.unreachable} unreachable`)
      }

      return { ...summary, accounts }
    }
    finally {
      db.close()
    }
  },
}
