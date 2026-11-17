/**
 * Serve the last answer at once and refresh it behind the request.
 *
 * For reads that are expensive to compute and cheap to be a minute old —
 * the candidate engine walks hundreds of markets and can take half a
 * minute against production data — a page should never wait on the
 * recomputation. The first caller after a cold start optionally waits;
 * everyone after gets the last value while a single refresh runs.
 */
export interface Snapshot<T> {
  value: T | null
  at: number
  refreshing: Promise<void> | null
}

export function snapshot<T>(): Snapshot<T> {
  return { value: null, at: 0, refreshing: null }
}

export function stale<T>(state: Snapshot<T>, ttlMs: number, load: () => Promise<T>, waitIfEmpty: boolean): Promise<T | null> {
  const fresh = Date.now() - state.at < ttlMs
  if (!fresh && !state.refreshing) {
    state.refreshing = load()
      .then((value) => {
        state.value = value
        state.at = Date.now()
      })
      .catch(() => undefined)
      .finally(() => {
        state.refreshing = null
      })
  }
  if (state.value !== null || !waitIfEmpty || !state.refreshing)
    return Promise.resolve(state.value)
  return state.refreshing.then(() => state.value)
}
