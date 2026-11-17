import type { RequestLike } from '../../Support/api'
import type { StreamFilter } from '../../Services/odds/stream'
import { Params, readHeader } from '../../Support/api'
import { Database } from '../../Support/db'
import { changesAfter, latestChangeId, sseFrame } from '../../Services/odds/stream'

/**
 * GET /api/feed/stream — every price change as it is stored, as
 * server-sent events.
 *
 * The REST side of the feed (`/api/feed/odds`, `/api/feed/history`, …) is
 * generated from the models by `useApi`. A stream is not CRUD, so it is the
 * one hand-written endpoint.
 *
 * Filters: `?sport=nba`, `?book=kalshi,polymarket`, `?event=123`,
 * `?market=h2h`. Resume with `?since=<id>` or the `Last-Event-ID` header;
 * with neither, the stream starts from now.
 *
 * Each connection lives for fifteen minutes and then closes cleanly, so a
 * proxy never holds a dead one forever. `EventSource` reconnects on its own
 * and resumes from the last id it saw.
 */

const POLL_MS = 1_000
const HEARTBEAT_MS = 15_000
const LIFETIME_MS = 15 * 60_000

export default {
  name: 'FeedStreamOdds',
  description: 'Every odds change as server-sent events, resumable by id.',

  async handle(request?: RequestLike & { signal?: AbortSignal }) {
    const params = new Params(request)
    const books = params.string('book', { max: 200 })
    const filter: StreamFilter = {
      sport: params.string('sport', { max: 40 }),
      books: books ? books.split(',').map(book => book.trim().toLowerCase()).filter(Boolean) : undefined,
      eventId: params.int('event', { min: 1 }),
      marketType: params.string('market', { max: 40 }),
    }
    const invalid = params.invalid()
    if (invalid)
      return invalid

    const resumeFrom = Number(params.string('since') ?? readHeader(request, 'last-event-id') ?? Number.NaN)
    const db = new Database()
    let cursor = Number.isFinite(resumeFrom) && resumeFrom >= 0 ? resumeFrom : await latestChangeId(db)

    const encoder = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | null = null
    let closed = false

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const startedAt = Date.now()
        let lastWrite = Date.now()
        let busy = false

        const close = () => {
          if (closed)
            return
          closed = true
          if (timer)
            clearInterval(timer)
          db.close()
          try {
            controller.close()
          }
          catch {}
        }

        request?.signal?.addEventListener('abort', close)
        // Tell EventSource how long to wait before reconnecting.
        controller.enqueue(encoder.encode(`retry: 2000\n: stream from ${cursor}\n\n`))

        timer = setInterval(() => {
          if (busy || closed)
            return
          if (Date.now() - startedAt > LIFETIME_MS)
            return close()
          busy = true
          void changesAfter(db, cursor, filter)
            .then((changes) => {
              if (closed)
                return
              for (const change of changes) {
                controller.enqueue(encoder.encode(sseFrame(change)))
                cursor = change.id
              }
              if (changes.length > 0) {
                lastWrite = Date.now()
              }
              else if (Date.now() - lastWrite > HEARTBEAT_MS) {
                // A comment line keeps proxies from timing the connection out.
                controller.enqueue(encoder.encode(': ping\n\n'))
                lastWrite = Date.now()
              }
            })
            .catch(() => close())
            .finally(() => { busy = false })
        }, POLL_MS)
      },
      cancel() {
        closed = true
        if (timer)
          clearInterval(timer)
        db.close()
      },
    })

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  },
}
