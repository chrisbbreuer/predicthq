import type { FeedEvent } from './provider'

/**
 * Coalesces pushed prices before they are written.
 *
 * A live game on an exchange can tick several times a second. Writing each
 * tick would turn one game into thousands of snapshot rows an hour and
 * keep the shared database busy for prices nobody reads at that grain.
 * Every push carries the whole of one book's quote on one game, so only
 * the latest per (book, game) matters: this keeps that one and hands the
 * batch to the writer every `intervalMs`.
 *
 * The writer stores a snapshot only when a price actually moved, so the
 * history keeps every distinct price that lasted at least one flush.
 */
export class PushBuffer {
  private pending = new Map<string, FeedEvent>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(
    private readonly write: (events: FeedEvent[]) => Promise<void>,
    private readonly intervalMs = 2_000,
  ) {}

  /** Number of games waiting for the next flush. */
  get size(): number {
    return this.pending.size
  }

  add(book: string, event: FeedEvent): void {
    this.pending.set(`${book}:${event.sportSlug}:${event.externalId}`, event)
  }

  start(): void {
    if (this.timer)
      return
    this.timer = setInterval(() => { void this.flush() }, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }

  /** Write what is pending. A flush already in flight is not doubled. */
  async flush(): Promise<number> {
    if (this.flushing || this.pending.size === 0)
      return 0
    this.flushing = true
    const batch = [...this.pending.values()]
    this.pending = new Map()
    try {
      await this.write(batch)
      return batch.length
    }
    finally {
      this.flushing = false
    }
  }
}
