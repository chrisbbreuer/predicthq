import type { RequestLike } from '../../Support/api'
import { fail, ok, Params } from '../../Support/api'
import { openRead } from '../../Support/db'
import { historicalBoard } from '../../Services/quant/history'

/**
 * GET /api/v1/historical/odds — the board as it stood at a moment.
 *
 * ### Why this is cheap for us and expensive elsewhere
 *
 * A paid feed charges roughly ten times a live call for a historical
 * snapshot, because storing every price at every instant is a genuine cost
 * for a business whose product is the live number.
 *
 * It is close to free here, and not because we are clever: the fair-value
 * model has to know where a line opened and how it moved, so
 * `odds_snapshots` was always going to exist. Serving it is a read against
 * a table we keep for our own sake.
 *
 * ### The snapshot is reconstructed, not stored
 *
 * There is no row saying "the board at 14:32". History is a **change log**
 * — a row exists only where a price moved — so the board at an instant is
 * the latest observation at or before it, per selection and book. That is
 * what makes a season of history affordable, and it is why this endpoint
 * does a `GROUP BY` rather than a lookup.
 */
export default {
  name: 'V1GetHistoricalOdds',
  description: 'The odds board reconstructed as it stood at a given timestamp.',

  async handle(request?: RequestLike) {
    const params = new Params(request)

    const at = params.instant('date')
    const sport = params.string('sport', { max: 40 })
    const limit = params.int('limit', { min: 1, max: 500, default: 100 })!
    const maxAgeMinutes = params.int('maxAgeMinutes', { min: 1, max: 60 })

    const invalid = params.invalid()
    if (invalid)
      return invalid

    if (at === undefined) {
      return fail('invalid_request', 'A `date` is required — the instant to reconstruct the board at.', {
        date: 'required',
      })
    }

    // A future timestamp would silently return the current board, which
    // reads as though we have prices we cannot have.
    if (Date.parse(at) > Date.now())
      return fail('invalid_request', 'That timestamp is in the future.', { date: 'must not be in the future' })

    const db = openRead()
    try {
      const rows = await historicalBoard(db, { at, sportSlug: sport, limit, maxAgeMinutes })

      return ok(rows, {
        request,
        // History does not change once written, so it can be cached hard.
        cacheSeconds: 300,
        meta: {
          at,
          note: maxAgeMinutes === undefined
            ? 'Latest price change at or before `at`. A change alone cannot establish that a quote was still fresh.'
            : 'Latest recorded sportsbook check at or before `at` within the requested age. Suspended and unobserved offers are omitted.',
        },
      })
    }
    finally {
      db.close()
    }
  },
}
