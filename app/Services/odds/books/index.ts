import type { BookAdapter } from './adapter'
import { enabledBooks } from '../../../../config/odds'
import { draftkings } from './draftkings'
import { kalshi } from './kalshi'
import { pinnacle } from './pinnacle'
import { polymarket } from './polymarket'

/**
 * The adapter registry.
 *
 * ### One at a time, each against a real payload
 *
 * An adapter has to be written against the book's actual response, and
 * that response can only be obtained by making the request. Writing one
 * from an assumed shape produces a file that looks finished, passes tests
 * against the assumption, and fails on first contact — worse than no
 * adapter, because it claims coverage we do not have.
 *
 * So each adapter lands with a recorded fixture in `tests/fixtures/`, taken
 * from a response the book actually sent, and its test pins the
 * translation against that.
 *
 * The engine handles an empty registry correctly: `refreshSchedule` skips
 * any league no adapter covers, so it schedules nothing and polls nothing
 * rather than looping on an empty fetch.
 */
const ADAPTERS: BookAdapter[] = [
  pinnacle,
  draftkings,
  kalshi,
  polymarket,
]

/**
 * Adapters that are both written and switched on.
 *
 * Two gates, and they answer different questions. Being in `ADAPTERS`
 * means the code exists; being in `enabledBooks()` means we currently want
 * to poll it. Keeping them apart is what lets a misbehaving book be turned
 * off through `ODDS_BOOKS_DISABLED` without deleting its adapter.
 */
export function activeAdapters(): BookAdapter[] {
  const enabled = new Set(enabledBooks().map(book => book.slug))
  return ADAPTERS.filter(adapter => enabled.has(adapter.slug))
}

/** Every adapter that exists, enabled or not. Used by preflight. */
export function allAdapters(): BookAdapter[] {
  return [...ADAPTERS]
}

/**
 * Books configured with a budget but with no adapter written yet.
 *
 * Surfaced rather than inferred: a book enabled in config with no adapter
 * behind it is silently absent from the board, which looks exactly like a
 * book that had nothing to quote.
 */
export function booksWithoutAdapters(): string[] {
  const written = new Set(ADAPTERS.map(adapter => adapter.slug))
  return enabledBooks()
    .map(book => book.slug)
    .filter(slug => !written.has(slug))
}
