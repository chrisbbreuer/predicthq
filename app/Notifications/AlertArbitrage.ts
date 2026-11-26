import { Database } from '../Support/db'
import { log } from '@stacksjs/logging'
import { useDatabase } from '@stacksjs/notifications'
import { publishRealtime } from '../Support/realtime'
import { deliverAlert } from '../Services/alerts'

export interface ArbitrageAlert {
  marketId: number
  title: string
  league: string
  profitPct: number
  legs: Array<{ pick: string, book: string, price: number }>
}

/**
 * Fire an alert when a fresh cross-book arbitrage appears.
 *
 * Three destinations, and they answer different questions:
 *
 *   The system row records that the arbitrage existed, which is the
 *   audit trail behind any later claim about what the board showed.
 *
 *   The realtime channel reaches whoever has the page open right now.
 *
 *   The subscriptions reach the people who asked to be told, wherever
 *   they are. That is the one that matters, because the moment an alert
 *   is worth something is the moment nobody is looking at the page.
 *
 * None of them is allowed to fail ingestion — an alert is worth less
 * than the pass that produced it — and none is allowed to fail silently
 * either. Both realtime and notification failures used to be swallowed
 * by a bare catch, so a table that had stopped accepting writes and a
 * broadcast server that was never running produced identical output.
 */
export async function alertArbitrage(arb: ArbitrageAlert): Promise<void> {
  try {
    // userId 0 = the system's own record, with no specific recipient.
    await useDatabase().send({ userId: 0, type: 'arbitrage', data: { ...arb } })
  }
  catch (error) {
    log.warn(`[alerts] could not record the arbitrage on ${arb.title}: ${message(error)}`)
  }

  try {
    await publishRealtime('alerts', 'arbitrage', arb)
  }
  catch (error) {
    log.warn(`[alerts] could not broadcast the arbitrage on ${arb.title}: ${message(error)}`)
  }

  const db = new Database()

  try {
    await deliverAlert(db, {
      kind: 'arbitrage',
      league: arb.league,
      venue: '',
      value: arb.profitPct,
      title: `${arb.profitPct.toFixed(2)}% arbitrage on ${arb.title}`,
      body: [
        `${arb.title} (${arb.league}) is showing a ${arb.profitPct.toFixed(2)}% cross-book arbitrage.`,
        '',
        ...arb.legs.map(leg => `  ${leg.pick} at ${leg.book} — ${leg.price}`),
      ].join('\n'),
      data: { ...arb },
    })
  }
  catch (error) {
    log.warn(`[alerts] could not deliver the arbitrage on ${arb.title} to subscribers: ${message(error)}`)
  }
  finally {
    db.close()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
