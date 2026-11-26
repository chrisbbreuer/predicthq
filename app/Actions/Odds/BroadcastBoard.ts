import { publishRealtime } from '../../Support/realtime'
import { loadBoard } from '../../Support/odds'

/**
 * Push the current odds board to every subscriber on the public `odds`
 * channel. Clients load the board once (GET /api/odds via GetBoard) and
 * then stay in sync from this broadcast — the realtime half of the same
 * query layer the REST actions expose.
 *
 * Runs on a schedule (see app/Scheduler.ts) and/or whenever a price
 * changes. With no broadcast server running it is a safe no-op.
 */
export default {
  name: 'BroadcastBoard',
  description: 'Broadcast the current odds board on the realtime `odds` channel.',

  async handle() {
    // Bounded deliberately. A broadcast payload goes to every connected
    // client on every tick, so it carries upcoming events without price
    // history — a subscriber that wants sparklines fetches the board once
    // over REST and keeps it in sync from these deltas.
    const board = await loadBoard({ status: 'scheduled', limit: 100, historyPoints: 0 })
    const payload = { at: new Date().toISOString(), summary: board.summary, events: board.events }

    try {
      await publishRealtime('odds', 'board:updated', payload)
      return { broadcast: true, channel: 'odds', event: 'board:updated', markets: board.events.length }
    }
    catch (err) {
      // No broadcast server running (e.g. dev without the realtime server,
      // or a one-off CLI run) — skip cleanly so the schedule never fails.
      // The REST board (GET /api/odds) still serves the same data.
      return { broadcast: false, reason: (err as Error).message, markets: board.events.length }
    }
  },
}
