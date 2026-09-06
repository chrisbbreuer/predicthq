import type { Database as Db } from '../../Support/db'
import type { PositionScorecard } from '../../Services/trading/position-scores'
import { Database } from '../../Support/db'
import { authenticatedUserId } from '../../Support/request-auth'
import { response } from '@stacksjs/router'
import { syncAccounts } from '../../Services/trading/account-sync'
import { positionScorecards, scorecardKey } from '../../Services/trading/position-scores'

/**
 * GET /api/trading/positions — the whole live book, in one read.
 *
 * Everything a user holds, everything still working, and what each is
 * worth right now. It is deliberately one endpoint rather than four: a
 * page that assembles a portfolio out of separate requests shows a cash
 * balance from one instant beside positions from another, and the sum of
 * those two numbers is a figure that was never true.
 *
 * Two sources are merged rather than shown side by side, because a user
 * holding one contract does not have two positions:
 *
 *   **Our book** (`exchange_positions`) — what a strategy opened, with
 *   the cost basis we watched being paid and the strategy that decided
 *   it. The only basis for performance, and blind to everything else.
 *
 *   **The venue's mirror** (`venue_positions`) — what the venue says the
 *   account holds, including positions taken by hand in the venue's own
 *   app. The authority on size, and silent about why.
 *
 * Where both describe the same market and side, the venue's size wins
 * and our basis and reasoning ride along. Paper positions belong to no
 * venue account and appear on their own, marked as paper: a simulated
 * holding shown as a real one is the single worst thing this page could
 * do.
 *
 * `?refresh=1` asks the venue rather than serving the last mirror,
 * throttled below to a rate a polling page cannot exceed.
 */

/**
 * How stale the mirror may be before `?refresh=1` re-reads the venue.
 *
 * The page polls, so without a floor here every open tab becomes a
 * multiplier on our request rate at Kalshi — the fastest way to have an
 * account rate limited is to render it.
 *
 * Deliberately shorter than the page's own ten-second poll rather than
 * equal to it. Set to the same ten seconds, whether a given poll reaches
 * the venue comes down to a few milliseconds of scheduling jitter, and
 * the page updates on every second poll about half the time. Eight
 * seconds is still slower than anyone reads and always inside the poll.
 */
const MIN_REFRESH_SECONDS = 8

interface AccountRow {
  id: number
  venue: string
  label: string
  masked_identifier: string
  status: string
  balance: number
  last_error: string
  last_synced_at: string
  jurisdiction: string
}

export interface BookRow {
  id: number
  trading_strategy_id: number
  strategy_name: string
  strategy_mode: string
  exchange_account_id: number | null
  venue: string
  market_external_id: string
  side: string
  size: number
  cost_basis: number
  opened_at: string
  question: string
  outcome_label: string
  category: string
  market_status: string
  last_price: number
  ends_at: string
}

export interface MirrorRow {
  venue: string
  market_external_id: string
  side: string
  size: number
  avg_price: number
  synced_at: string
  question: string
  outcome_label: string
  category: string
  market_status: string
  last_price: number
  ends_at: string
}

interface OrderRow {
  id: number
  venue: string
  market_external_id: string
  external_order_id: string
  side: string
  limit_price: number
  size: number
  filled_size: number
  status: string
  placed_at: string
  strategy_name: string
  strategy_mode: string
  question: string
  outcome_label: string
}

interface VenueOrderRow {
  venue: string
  market_external_id: string
  external_order_id: string
  side: string
  limit_price: number
  size: number
  remaining_size: number
  placed_at: string
  question: string
  outcome_label: string
}

interface DecisionRow {
  id: number
  strategy_name: string
  venue: string
  side: string
  market_price: number
  fair_value: number
  edge: number
  confidence: number
  limit_price: number
  size: number
  notional: number
  rationale: string
  status: string
  status_reason: string
  created_at: string
  question: string
  outcome_label: string
}

interface SettledRow {
  venue: string
  market_external_id: string
  side: string
  size: number
  cost_basis: number
  realized_pnl: number
  settlement_price: number
  settled_at: string
  strategy_name: string
  strategy_mode: string
  question: string
  outcome_label: string
}

/** One line of the merged book. */
export interface Holding {
  venue: string
  marketExternalId: string
  question: string
  outcomeLabel: string
  category: string
  marketStatus: string
  endsAt: string
  side: string
  size: number
  avgPrice: number
  cost: number
  mark: number
  markValue: number
  unrealized: number
  /** 'venue' | 'engine' | 'both' | 'paper' */
  source: string
  openedAt: string
  strategies: Array<{ name: string, mode: string, size: number, cost: number }>
  scorecard?: PositionScorecard | null
}

export default {
  name: 'GetPositions',
  description: 'Every open position, working order, and pending decision, marked to the current price.',

  async handle(request?: { get?: (key: string) => string | undefined, user?: { id?: number } }) {
    const userId = await authenticatedUserId(request)
    if (!userId)
      return response.error('Sign in to view your positions.', 401)

    const db = new Database()

    try {
      const accounts = await db.prepare<AccountRow>(`
        SELECT id, venue, label, masked_identifier, status, balance, last_error,
          last_synced_at, jurisdiction
        FROM exchange_accounts
        WHERE user_id = ? AND status != 'disconnected'
        ORDER BY venue
      `).all(userId)

      const refreshed = wantsRefresh(request) && staleEnough(accounts)
      if (refreshed)
        await refresh(db, userId)

      const [book, mirror, orders, venueOrders, pending, settled, realized] = await Promise.all([
        openBook(db, userId),
        venueMirror(db, userId),
        workingOrders(db, userId),
        restingVenueOrders(db, userId),
        pendingDecisions(db, userId),
        recentSettlements(db, userId),
        realizedTotals(db, userId),
      ])

      // Re-read the accounts we just refreshed, so the balance beside the
      // positions is from the same pass that produced them.
      const current = refreshed
        ? await db.prepare<AccountRow>(`
            SELECT id, venue, label, masked_identifier, status, balance, last_error,
              last_synced_at, jurisdiction
            FROM exchange_accounts
            WHERE user_id = ? AND status != 'disconnected'
            ORDER BY venue
          `).all(userId)
        : accounts

      const holdings = mergeHoldings(book, mirror)
      const tracked = new Set(orders.map(order => order.external_order_id).filter(Boolean))

      const working = [
        ...orders.map(order => ({
          venue: order.venue,
          marketExternalId: order.market_external_id,
          question: order.question || order.market_external_id,
          outcomeLabel: order.outcome_label,
          side: order.side,
          limitPrice: round(order.limit_price),
          size: Number(order.size),
          remaining: round(Number(order.size) - Number(order.filled_size ?? 0)),
          committed: round((Number(order.size) - Number(order.filled_size ?? 0)) * Number(order.limit_price)),
          status: order.status,
          placedAt: order.placed_at,
          strategy: order.strategy_name,
          mode: order.strategy_mode || 'live',
          source: 'engine',
        })),
        // Orders the user placed at the venue themselves. Matched out by
        // venue id first: one order shown twice reads as twice the risk.
        ...venueOrders.filter(order => !tracked.has(order.external_order_id)).map(order => ({
          venue: order.venue,
          marketExternalId: order.market_external_id,
          question: order.question || order.market_external_id,
          outcomeLabel: order.outcome_label,
          side: order.side,
          limitPrice: round(order.limit_price),
          size: Number(order.size),
          remaining: round(Number(order.remaining_size)),
          committed: round(Number(order.remaining_size) * Number(order.limit_price)),
          status: 'resting',
          placedAt: order.placed_at,
          strategy: '',
          mode: 'live',
          source: 'venue',
        })),
      ].sort((a, b) => b.placedAt.localeCompare(a.placedAt))

      const live = holdings.filter(holding => holding.source !== 'paper')
      const paper = holdings.filter(holding => holding.source === 'paper')
      // A score provider going quiet must never hide the portfolio itself.
      // The cards simply fall back to no scorecard until the next poll.
      const scorecards = await positionScorecards(live).catch(() => new Map())

      return {
        refreshedFromVenue: refreshed,
        asOf: new Date().toISOString(),
        accounts: current.map(account => ({
          venue: account.venue,
          label: account.label,
          maskedIdentifier: account.masked_identifier,
          status: account.status,
          balance: round(Number(account.balance)),
          lastError: account.last_error,
          lastSyncedAt: account.last_synced_at,
          jurisdiction: account.jurisdiction,
        })),
        totals: {
          cash: round(current.reduce((sum, account) => sum + Number(account.balance), 0)),
          positions: live.length,
          cost: round(live.reduce((sum, holding) => sum + holding.cost, 0)),
          markValue: round(live.reduce((sum, holding) => sum + holding.markValue, 0)),
          unrealized: round(live.reduce((sum, holding) => sum + holding.unrealized, 0)),
          working: working.length,
          committed: round(working.reduce((sum, order) => sum + order.committed, 0)),
          realizedToday: realized.today,
          realizedAll: realized.all,
          // Paper is summarized apart from the money numbers above on
          // purpose: adding a simulated gain to a real balance produces a
          // figure that describes nothing.
          paperPositions: paper.length,
          paperUnrealized: round(paper.reduce((sum, holding) => sum + holding.unrealized, 0)),
        },
        positions: holdings.map(holding => ({
          ...holding,
          scorecard: holding.source === 'paper'
            ? null
            : scorecards.get(scorecardKey(holding)) ?? null,
        })),
        orders: working,
        pending: pending.map(decision => ({
          id: decision.id,
          strategy: decision.strategy_name,
          venue: decision.venue,
          question: decision.question || '',
          outcomeLabel: decision.outcome_label,
          side: decision.side,
          marketPrice: decision.market_price,
          fairValue: decision.fair_value,
          edge: decision.edge,
          confidence: decision.confidence,
          limitPrice: decision.limit_price,
          size: decision.size,
          notional: decision.notional,
          rationale: decision.rationale,
          status: decision.status,
          statusReason: decision.status_reason,
          createdAt: decision.created_at,
        })),
        settled: settled.map(position => ({
          venue: position.venue,
          marketExternalId: position.market_external_id,
          question: position.question || position.market_external_id,
          outcomeLabel: position.outcome_label,
          side: position.side,
          size: Number(position.size),
          cost: round(Number(position.cost_basis)),
          realized: round(Number(position.realized_pnl)),
          won: Number(position.settlement_price) > 0,
          settledAt: position.settled_at,
          strategy: position.strategy_name,
          mode: position.strategy_mode || 'live',
        })),
      }
    }
    finally {
      db.close()
    }
  },
}

function wantsRefresh(request?: { get?: (key: string) => string | undefined }): boolean {
  const value = request?.get?.('refresh') ?? ''
  return value === '1' || value.toLowerCase() === 'true'
}

/** True when no account has been read from its venue very recently. */
function staleEnough(accounts: AccountRow[]): boolean {
  const active = accounts.filter(account => account.status === 'active')
  if (active.length === 0)
    return false

  const floor = Date.now() - MIN_REFRESH_SECONDS * 1000

  return active.some((account) => {
    const synced = instant(account.last_synced_at)
    return synced === null || synced < floor
  })
}

/**
 * A stored timestamp as an instant, or null when it is not one.
 *
 * Timestamps are written in UTC and stored without a zone, because the
 * MySQL wire protocol behind Vitess rejects the `T` and the trailing `Z`
 * (see `databaseValue`). `Date.parse` reads what comes back as *local*
 * time, which in any zone west of Greenwich makes every row look older
 * than it is — here, that would defeat the refresh floor and let a
 * polling page hit the venue on every request. So the zone is put back
 * before parsing rather than assumed.
 */
function instant(timestamp: string | null | undefined): number | null {
  if (!timestamp)
    return null

  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(timestamp) && !/[Z+]|-\d{2}:\d{2}$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z`
    : timestamp

  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Read the venues, and never let that failure become the page's.
 *
 * The mirror is already in the database. A venue that times out costs
 * the user a few seconds of freshness, which is worth strictly less than
 * the portfolio itself, and `syncAccounts` has already written the
 * reason onto the account for the page to show.
 */
async function refresh(db: Db, userId: number): Promise<void> {
  await syncAccounts(db, { userId }).catch(() => undefined)
}

/** Open positions our own strategies opened, with their market. */
function openBook(db: Db, userId: number): Promise<BookRow[]> {
  return db.prepare<BookRow>(`
    SELECT
      p.id, p.trading_strategy_id, s.name AS strategy_name, s.mode AS strategy_mode,
      p.exchange_account_id, p.venue, p.market_external_id, p.side, p.size,
      p.cost_basis, p.opened_at,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label,
      COALESCE(m.category, '') AS category, COALESCE(m.status, '') AS market_status,
      COALESCE(m.last_price, 0) AS last_price, COALESCE(m.ends_at, '') AS ends_at
    FROM exchange_positions p
    JOIN trading_strategies s ON s.id = p.trading_strategy_id
    LEFT JOIN prediction_markets m ON m.id = p.prediction_market_id
    WHERE s.user_id = ? AND p.status = 'open' AND p.size > 0
    ORDER BY p.opened_at DESC, p.id DESC
  `).all(userId)
}

/** What the venues say the user's accounts hold. */
function venueMirror(db: Db, userId: number): Promise<MirrorRow[]> {
  return db.prepare<MirrorRow>(`
    SELECT
      v.venue, v.market_external_id, v.side, v.size, v.avg_price, v.synced_at,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label,
      COALESCE(m.category, '') AS category, COALESCE(m.status, '') AS market_status,
      COALESCE(m.last_price, 0) AS last_price, COALESCE(m.ends_at, '') AS ends_at
    FROM venue_positions v
    JOIN exchange_accounts a ON a.id = v.exchange_account_id
    LEFT JOIN prediction_markets m ON m.id = v.prediction_market_id
    WHERE a.user_id = ? AND v.size > 0
    ORDER BY v.id
  `).all(userId)
}

/** Our orders that can still fill. */
function workingOrders(db: Db, userId: number): Promise<OrderRow[]> {
  return db.prepare<OrderRow>(`
    SELECT
      o.id, o.venue, o.market_external_id, o.external_order_id, o.side, o.limit_price,
      o.size, o.filled_size, o.status, o.placed_at,
      s.name AS strategy_name, s.mode AS strategy_mode,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label
    FROM exchange_orders o
    JOIN trade_decisions d ON d.id = o.trade_decision_id
    JOIN trading_strategies s ON s.id = d.trading_strategy_id
    LEFT JOIN prediction_markets m ON m.id = d.prediction_market_id
    WHERE s.user_id = ? AND o.status IN ('pending', 'open', 'partial')
    ORDER BY o.placed_at DESC
  `).all(userId)
}

/** Orders resting at the venue, whoever placed them. */
function restingVenueOrders(db: Db, userId: number): Promise<VenueOrderRow[]> {
  return db.prepare<VenueOrderRow>(`
    SELECT
      v.venue, v.market_external_id, v.external_order_id, v.side, v.limit_price,
      v.size, v.remaining_size, v.placed_at,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label
    FROM venue_orders v
    JOIN exchange_accounts a ON a.id = v.exchange_account_id
    LEFT JOIN prediction_markets m ON m.id = v.prediction_market_id
    WHERE a.user_id = ? AND v.remaining_size > 0
    ORDER BY v.placed_at DESC
  `).all(userId)
}

/**
 * Decisions that have not become orders yet.
 *
 * 'approved' is the engine's verdict waiting on execution — a strategy
 * left on manual, or a plan without automated execution. 'review' is an
 * order whose fate we could not establish. Both are live action in the
 * sense that matters: something is about to happen, or should be.
 */
function pendingDecisions(db: Db, userId: number): Promise<DecisionRow[]> {
  return db.prepare<DecisionRow>(`
    SELECT
      d.id, s.name AS strategy_name, d.venue, d.side, d.market_price, d.fair_value,
      d.edge, d.confidence, d.limit_price, d.size, d.notional, d.rationale,
      d.status, d.status_reason, d.created_at,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label
    FROM trade_decisions d
    JOIN trading_strategies s ON s.id = d.trading_strategy_id
    LEFT JOIN prediction_markets m ON m.id = d.prediction_market_id
    WHERE s.user_id = ? AND d.status IN ('approved', 'review')
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT 25
  `).all(userId)
}

/** The last positions to resolve, and what they returned. */
function recentSettlements(db: Db, userId: number): Promise<SettledRow[]> {
  return db.prepare<SettledRow>(`
    SELECT
      p.venue, p.market_external_id, p.side, p.size, p.cost_basis, p.realized_pnl,
      p.settlement_price, p.settled_at, s.name AS strategy_name, s.mode AS strategy_mode,
      COALESCE(m.question, '') AS question, COALESCE(m.outcome_label, '') AS outcome_label
    FROM exchange_positions p
    JOIN trading_strategies s ON s.id = p.trading_strategy_id
    LEFT JOIN prediction_markets m ON m.id = p.prediction_market_id
    WHERE s.user_id = ? AND p.status = 'settled'
    ORDER BY p.settled_at DESC, p.id DESC
    LIMIT 20
  `).all(userId)
}

/** Realized profit and loss, today and over everything. */
async function realizedTotals(db: Db, userId: number): Promise<{ today: number, all: number }> {
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)

  // Aliased away from `today`/`all`: `all` is reserved in SQLite and the
  // statement will not even parse with it.
  const row = await db.prepare<{ today_pnl: number, total_pnl: number }>(`
    SELECT
      COALESCE(SUM(CASE WHEN p.settled_at >= ? THEN p.realized_pnl ELSE 0 END), 0) AS today_pnl,
      COALESCE(SUM(p.realized_pnl), 0) AS total_pnl
    FROM exchange_positions p
    JOIN trading_strategies s ON s.id = p.trading_strategy_id
    WHERE s.user_id = ? AND p.status = 'settled'
  `).get(midnight.toISOString(), userId)

  return { today: round(Number(row?.today_pnl ?? 0)), all: round(Number(row?.total_pnl ?? 0)) }
}

/**
 * One line per market and side held, from both sources.
 *
 * The venue is the authority on how much is held and what it cost —
 * those are its own records of its own fills. Our book contributes the
 * part the venue cannot know: which strategy opened it and on what
 * reasoning. When only one source has the line, that source describes it
 * alone, which is how a hand-placed position and a paper position both
 * end up visible on the same page without being confused for each other.
 */
export function mergeHoldings(book: BookRow[], mirror: MirrorRow[]): Holding[] {
  const holdings = new Map<string, Holding>()
  // Which keys the venue itself reported. Membership is what "the venue
  // also holds this" means — asking the map alone would let the second
  // of two strategies in one market mistake the first for the venue.
  const reported = new Set<string>()

  for (const row of mirror) {
    const key = keyFor(row.venue, row.market_external_id, row.side)
    const size = Number(row.size)
    reported.add(key)
    const price = markFor(Number(row.last_price), row.side)

    holdings.set(key, {
      venue: row.venue,
      marketExternalId: row.market_external_id,
      question: row.question || row.market_external_id,
      outcomeLabel: row.outcome_label,
      category: row.category,
      marketStatus: row.market_status,
      endsAt: row.ends_at,
      side: row.side,
      size,
      avgPrice: round(Number(row.avg_price)),
      cost: round(size * Number(row.avg_price)),
      mark: price,
      markValue: round(size * price),
      unrealized: round(size * price - size * Number(row.avg_price)),
      source: 'venue',
      openedAt: '',
      strategies: [],
    })
  }

  for (const row of book) {
    const key = keyFor(row.venue, row.market_external_id, row.side)
    const size = Number(row.size)
    const cost = Number(row.cost_basis)
    const paper = (row.strategy_mode || 'live') === 'paper' || row.exchange_account_id === null
    const existing = !paper && reported.has(key) ? holdings.get(key) : undefined

    const attribution = {
      name: row.strategy_name,
      mode: row.strategy_mode || 'live',
      size,
      cost: round(cost),
    }

    if (existing) {
      existing.source = 'both'
      existing.strategies.push(attribution)
      existing.openedAt = existing.openedAt || row.opened_at
      // The question text can come from either side; prefer whichever
      // actually has it rather than showing a ticker next to a row that
      // knows the real title.
      if (existing.question === existing.marketExternalId && row.question)
        existing.question = row.question
      continue
    }

    // Paper positions are keyed apart from live ones so a simulated and a
    // real holding in the same market never merge into one line.
    const price = markFor(Number(row.last_price), row.side)
    const ownKey = paper ? `paper:${key}:${row.trading_strategy_id}` : key
    const prior = holdings.get(ownKey)

    if (prior) {
      // Two strategies, same market and side, same mode: one holding,
      // both attributions, sizes and costs added.
      prior.size += size
      prior.cost = round(prior.cost + cost)
      prior.avgPrice = prior.size > 0 ? round(prior.cost / prior.size) : 0
      prior.markValue = round(prior.size * price)
      prior.unrealized = round(prior.markValue - prior.cost)
      prior.strategies.push(attribution)
      continue
    }

    holdings.set(ownKey, {
      venue: row.venue,
      marketExternalId: row.market_external_id,
      question: row.question || row.market_external_id,
      outcomeLabel: row.outcome_label,
      category: row.category,
      marketStatus: row.market_status,
      endsAt: row.ends_at,
      side: row.side,
      size,
      avgPrice: size > 0 ? round(cost / size) : 0,
      cost: round(cost),
      mark: price,
      markValue: round(size * price),
      unrealized: round(size * price - cost),
      source: paper ? 'paper' : 'engine',
      openedAt: row.opened_at,
      strategies: [attribution],
    })
  }

  return [...holdings.values()].sort((a, b) => b.markValue - a.markValue)
}

function keyFor(venue: string, marketExternalId: string, side: string): string {
  return `${venue}:${marketExternalId}:${side.toLowerCase()}`
}

/**
 * What one contract is worth right now.
 *
 * Markets are quoted on the YES side, so a NO contract marks at one
 * minus that price — they are the two halves of a dollar. A market we
 * have no price for marks at zero rather than at cost: an unmarked
 * position is not a position at break-even, and showing it as one
 * invents a profit of exactly nothing.
 */
function markFor(lastPrice: number, side: string): number {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0)
    return 0

  return side.toLowerCase() === 'no' ? round(1 - lastPrice) : round(lastPrice)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
