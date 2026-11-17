import type { Database } from '../../Support/db'
import { lineKey, nameSimilarity, norm, nowIso } from '../../Support/keys'

/**
 * Identity resolution — deciding that a thing a provider just described is
 * a thing we already have.
 *
 * This module exists because the previous ingestion had no answer to that
 * question. It matched incoming outcomes to stored rows by normalized
 * *label*, globally across every event, using a map built from
 * `SELECT id, label FROM selections`. Two failures followed and neither
 * announced itself:
 *
 *  1. Labels are not unique. "Home", "Draw", "Over", and "Yes" repeat on
 *     every event, and building a Map from those pairs keeps the last one
 *     written — so a price for one game landed on a different game.
 *  2. Labels are not stable across feeds. The feed says "Los Angeles
 *     Lakers"; the row said "Lakers". Normalizing both still leaves
 *     `losangeleslakers` ≠ `lakers`, so in practice almost nothing matched
 *     at all, and the board simply stopped moving.
 *
 * Matching now happens **once**, when an event is first seen, and is
 * recorded in `event_sources`. Every subsequent price update joins on the
 * provider's own id and cannot drift. Names are only consulted to
 * establish that first link, and when they are, the decision is stored
 * with its method and confidence so a bad link is auditable rather than
 * mysterious.
 */

/**
 * Remembered ids, for processes that resolve the same identities all day.
 *
 * The realtime loop resolves every streamed game every two seconds, and
 * each resolution is a handful of reads plus touch-and-update writes for
 * rows that have not changed. Teams, events, markets and selections are
 * never deleted, so an id once found stays right; remembering it for a few
 * minutes takes those queries off the shared database.
 *
 * Off by default and switched on by `odds:watch` alone: tests rebuild their
 * database between cases, and an id remembered from the last one would
 * point at a row the next one never made. Only ids read back from a
 * committed row are remembered, never one just inserted inside a
 * transaction that might still roll back.
 */
const memo = new Map<string, { id: number, at: number }>()
let memoTtlMs = 0

export function enableIdentityMemo(ttlMs = 10 * 60_000): void {
  memoTtlMs = ttlMs
}

function recall(key: string): number | null {
  if (memoTtlMs <= 0)
    return null
  const hit = memo.get(key)
  if (!hit || Date.now() - hit.at > memoTtlMs)
    return null
  return hit.id
}

function remember(key: string, id: number): void {
  if (memoTtlMs <= 0)
    return
  if (memo.size > 100_000)
    memo.clear()
  memo.set(key, { id, at: Date.now() })
}

export interface SportRow {
  id: number
  slug: string
  title: string
  grouping: string
  espn_path: string
  odds_api_key: string
  non_sporting: number
}

/** What the database drivers accept as a bound parameter. */
export type Binding = string | number | bigint | boolean | null

/** Active sports, in display order. */
export async function loadSports(db: Database): Promise<SportRow[]> {
  return await db.query<SportRow>(`
    SELECT id, slug, title, grouping, espn_path, odds_api_key, non_sporting
    FROM sports WHERE active = 1 ORDER BY position ASC, id ASC
  `).all()
}

/**
 * Find or create the team, and teach it any new spelling we just saw.
 *
 * Resolution runs in three passes, cheapest first:
 *
 *  1. Exact `searchKey` — the normal case, one indexed lookup.
 *  2. Alias list — a spelling a previous fuzzy match already learned.
 *  3. Fuzzy over the sport's teams, above a deliberately high threshold.
 *
 * The fuzzy pass writes what it learned back to `aliases`, so each novel
 * spelling costs a scan exactly once and is an indexed hit forever after.
 * The bar is high (0.7) because a wrong team link is far more damaging
 * than an unlinked one: an unmatched team leaves a gap someone notices,
 * while a mismatched team silently attributes prices, results, and grades
 * to the wrong club.
 */
/**
 * Look a club up without creating one.
 *
 * `resolveTeam` inserts on a miss, which is right for a league feed that
 * is the authority on its own members and wrong for a cup fixture, where
 * a miss usually means the club is already on file under the division it
 * actually plays in. Callers spanning several leagues need to ask before
 * they create.
 */
export async function resolveExistingTeam(db: Database, sportId: number, name: string): Promise<number | null> {
  const key = norm(name.trim())
  if (!key)
    return null

  const exact = await db
    .query('SELECT id FROM sports_teams WHERE sport_id = ? AND search_key = ?')
    .get(sportId, key) as { id: number } | null

  if (exact)
    return exact.id

  const candidates = await db
    .query('SELECT id, name, aliases FROM sports_teams WHERE sport_id = ?')
    .all(sportId) as Array<{ id: number, name: string, aliases: string }>

  for (const row of candidates) {
    const aliases = row.aliases ? row.aliases.split('\n').filter(Boolean) : []
    if (aliases.includes(key))
      return row.id
  }

  // Token containment, and only when exactly one club matches.
  //
  // Feeds disagree about how much of a club's name to print: Kalshi says
  // 'Crawley' where ESPN says 'Crawley Town', 'Wolves' for 'Wolverhampton
  // Wanderers'. Character similarity scores those below any sane
  // threshold ('Crawley' against 'Crawley Town' is barely half), so
  // without this the club reads as unknown.
  //
  // Uniqueness is the safeguard. 'United' sits inside Manchester United
  // and Newcastle United alike, and a containment rule that picked the
  // first would attach a fixture to the wrong club silently. Ambiguity
  // returns null and the caller declines instead.
  const words = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  const needle = words(name)

  if (needle.length > 0) {
    const contained = candidates.filter((row) => {
      const hay = words(row.name)
      return needle.every(word => hay.includes(word)) || hay.every(word => needle.includes(word))
    })

    if (contained.length === 1)
      return contained[0]!.id

    // More than one club contains the name. Stop here rather than falling
    // through: the fuzzy pass below would happily score 'United' against
    // 'Manchester United' above threshold and pick it, quietly undoing
    // the very check this is.
    if (contained.length > 1)
      return null
  }

  // Fuzzy, on the same threshold `resolveTeam` uses.
  let best: { id: number, score: number } | null = null
  for (const row of candidates) {
    const score = nameSimilarity(name.trim(), row.name)
    if (best === null || score > best.score)
      best = { id: row.id, score }
  }

  return best && best.score >= 0.7 ? best.id : null
}

export async function resolveTeam(
  db: Database,
  sportId: number,
  name: string,
  extra: { abbreviation?: string, shortName?: string, logo?: string, espnId?: string, record?: string } = {},
): Promise<number | null> {
  const clean = name.trim()
  if (!clean)
    return null

  const key = norm(clean)
  if (!key)
    return null

  const memoKey = `team:${sportId}:${key}`
  const known = recall(memoKey)
  if (known !== null)
    return known

  const exact = await db
    .query('SELECT id FROM sports_teams WHERE sport_id = ? AND search_key = ?')
    .get(sportId, key) as { id: number } | null

  if (exact) {
    await refreshTeam(db, exact.id, extra)
    remember(memoKey, exact.id)
    return exact.id
  }

  const candidates = await db
    .query('SELECT id, name, search_key, aliases FROM sports_teams WHERE sport_id = ?')
    .all(sportId) as Array<{ id: number, name: string, search_key: string, aliases: string }>

  // Pass 2 — a spelling we have already learned.
  for (const row of candidates) {
    const aliases = row.aliases ? row.aliases.split('\n').filter(Boolean) : []
    if (aliases.includes(key)) {
      await refreshTeam(db, row.id, extra)
      return row.id
    }
  }

  // Pass 3 — fuzzy, and only when clearly the best match.
  let best: { id: number, score: number, aliases: string } | null = null
  for (const row of candidates) {
    const score = nameSimilarity(clean, row.name)
    if (best === null || score > best.score)
      best = { id: row.id, score, aliases: row.aliases }
  }

  if (best && best.score >= 0.7) {
    const aliases = best.aliases ? best.aliases.split('\n').filter(Boolean) : []
    if (!aliases.includes(key))
      aliases.push(key)
    await db.prepare('UPDATE sports_teams SET aliases = ?, updated_at = ? WHERE id = ?')
      .run(aliases.join('\n'), nowIso(), best.id)
    await refreshTeam(db, best.id, extra)
    return best.id
  }

  const res = await db.prepare(`
    INSERT INTO sports_teams (sport_id, name, search_key, short_name, abbreviation, logo, espn_id, record, aliases, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
  `).run(
    sportId,
    clean,
    key,
    extra.shortName ?? '',
    extra.abbreviation ?? '',
    extra.logo ?? '',
    extra.espnId ?? '',
    extra.record ?? '',
    nowIso(),
    nowIso(),
  )
  return Number(res.lastInsertRowid)
}

/** Fill in fields that arrive later (logos, records) without clobbering. */
async function refreshTeam(
  db: Database,
  id: number,
  extra: { abbreviation?: string, shortName?: string, logo?: string, espnId?: string, record?: string },
): Promise<void> {
  const sets: string[] = []
  const params: Binding[] = []

  // COALESCE-style: only overwrite when we actually have a value, so a
  // feed that omits logos on one pass does not blank the ones we hold.
  for (const [column, value] of [
    ['short_name', extra.shortName],
    ['abbreviation', extra.abbreviation],
    ['logo', extra.logo],
    ['espn_id', extra.espnId],
    ['record', extra.record],
  ] as Array<[string, string | undefined]>) {
    if (value) {
      sets.push(`${column} = ?`)
      params.push(value)
    }
  }

  if (sets.length === 0)
    return

  sets.push('updated_at = ?')
  params.push(nowIso(), id)
  await db.prepare(`UPDATE sports_teams SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export interface EventIdentity {
  sportId: number
  provider: string
  externalId: string
  title: string
  commenceAt: string
  homeTeamId?: number | null
  awayTeamId?: number | null
  category?: string
  league?: string
  venue?: string
  broadcast?: string
}

/**
 * Find or create the event this provider record refers to, and record the
 * link in `event_sources`.
 *
 * Resolution order:
 *
 *  1. This provider's own id — an exact, previously-agreed link.
 *  2. The same two teams kicking off within a few hours — how a *second*
 *     provider's record gets attached to an event the first one created.
 *     Matching on the team pair is the strong constraint; the time window
 *     only has to separate this fixture from the next meeting of the same
 *     two clubs, and it is bounded tightly because teams play the same
 *     opponent on consecutive days all the time.
 *
 * Failing both, a new event is created. Creating a duplicate is the safe
 * error here: it shows up as two cards on the board, which someone reports.
 * Merging two different games is silent and corrupts every number
 * downstream.
 */
export async function resolveEvent(db: Database, identity: EventIdentity): Promise<{ eventId: number, created: boolean }> {
  // Remembered links skip the touch and the update: both were done when it
  // was first found, and repeating them every flush rewrites the same row.
  const memoKey = `event:${identity.provider}:${identity.externalId}:${identity.commenceAt}`
  const known = recall(memoKey)
  if (known !== null)
    return { eventId: known, created: false }

  const existingLink = await db
    .query('SELECT market_event_id FROM event_sources WHERE provider = ? AND external_id = ?')
    .get(identity.provider, identity.externalId) as { market_event_id: number } | null

  if (existingLink) {
    await touchEventSource(db, identity.provider, identity.externalId)
    await updateEvent(db, existingLink.market_event_id, identity)
    remember(memoKey, existingLink.market_event_id)
    return { eventId: existingLink.market_event_id, created: false }
  }

  let eventId: number | null = null
  let matchedBy = 'external_id'
  let confidence = 1

  if (identity.homeTeamId && identity.awayTeamId && identity.commenceAt) {
    // Six hours, not a day. Teams play the same opponent on consecutive
    // days all the time — a baseball series is three or four straight
    // meetings of the identical pair — so a ±24h window merges distinct
    // games into one. Providers disagree about start times by minutes,
    // occasionally by an hour when a broadcast slot moves, so six hours
    // absorbs every real discrepancy while staying far inside the ~18h
    // gap between two games of a series.
    const windowMs = 6 * 60 * 60 * 1000
    const target = new Date(identity.commenceAt).getTime()
    if (Number.isFinite(target)) {
      const lower = new Date(target - windowMs).toISOString()
      const upper = new Date(target + windowMs).toISOString()

      // Never merge into an event this same provider has already claimed.
      // If ESPN already linked an event and hands us a *different* id, it
      // is by definition a different game — the provider's own ids are
      // authoritative within that provider. Without this guard the time
      // window is the only thing standing between a series and a merge,
      // and it is not enough on its own.
      const matches = await db.query<{ id: number, commence_at: string }>(`
        SELECT e.id, e.commence_at FROM market_events e
        WHERE e.sport_id = ? AND e.home_sports_team_id = ? AND e.away_sports_team_id = ?
          AND e.commence_at BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM event_sources es
            WHERE es.market_event_id = e.id AND es.provider = ?
          )
        ORDER BY e.commence_at ASC
      `).all(
        identity.sportId,
        identity.homeTeamId,
        identity.awayTeamId,
        lower,
        upper,
        identity.provider,
      )
      const match = matches.sort((left, right) =>
        Math.abs(new Date(left.commence_at).getTime() - target) - Math.abs(new Date(right.commence_at).getTime() - target),
      )[0]

      if (match) {
        eventId = match.id
        matchedBy = 'team_pair'
        confidence = 0.9
      }
    }
  }

  let created = false
  if (eventId === null) {
    const res = await db.prepare(`
      INSERT INTO market_events
        (sport_id, title, category, league, commence_at, status,
        home_sports_team_id, away_sports_team_id, venue, broadcast,
        status_detail, last_seen_at, closing_captured_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, '', ?, '', ?, ?)
    `).run(
      identity.sportId,
      identity.title,
      identity.category ?? '',
      identity.league ?? '',
      identity.commenceAt,
      identity.homeTeamId ?? null,
      identity.awayTeamId ?? null,
      identity.venue ?? '',
      identity.broadcast ?? '',
      nowIso(),
      nowIso(),
      nowIso(),
    )
    eventId = Number(res.lastInsertRowid)
    created = true
  }
  else {
    await updateEvent(db, eventId, identity)
  }

  await db.updateOrInsert('event_sources', { provider: identity.provider, external_id: identity.externalId }, {
    market_event_id: eventId,
    matched_by: matchedBy,
    confidence,
    external_title: identity.title.slice(0, 240),
    last_seen_at: nowIso(),
    updated_at: nowIso(),
  })

  return { eventId, created }
}

async function touchEventSource(db: Database, provider: string, externalId: string): Promise<void> {
  await db.prepare('UPDATE event_sources SET last_seen_at = ?, updated_at = ? WHERE provider = ? AND external_id = ?')
    .run(nowIso(), nowIso(), provider, externalId)
}

/**
 * Refresh the mutable parts of a known event.
 *
 * Only fills blanks and moves the start time — it never overwrites a title
 * or a team with an empty value, because providers routinely omit fields
 * they sent last time and a naive write would erase good data with nothing.
 */
async function updateEvent(db: Database, eventId: number, identity: EventIdentity): Promise<void> {
  await db.prepare(`
    UPDATE market_events SET
      commence_at = CASE WHEN ? != '' THEN ? ELSE commence_at END,
      venue = CASE WHEN ? != '' THEN ? ELSE venue END,
      broadcast = CASE WHEN ? != '' THEN ? ELSE broadcast END,
      home_sports_team_id = COALESCE(home_sports_team_id, ?),
      away_sports_team_id = COALESCE(away_sports_team_id, ?),
      last_seen_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    identity.commenceAt,
    identity.commenceAt,
    identity.venue ?? '',
    identity.venue ?? '',
    identity.broadcast ?? '',
    identity.broadcast ?? '',
    identity.homeTeamId ?? null,
    identity.awayTeamId ?? null,
    nowIso(),
    nowIso(),
    eventId,
  )
}

export interface MarketIdentity {
  eventId: number
  marketType: string
  line: number | null
  period?: string
  label?: string
  playerName?: string
  complete?: boolean
  position?: number
}

/**
 * Find or create a market. Idempotent on
 * (event, type, line, period) via the `line_key` unique index.
 */
export async function resolveMarket(db: Database, identity: MarketIdentity): Promise<number> {
  const period = identity.period ?? 'full_game'
  const key = lineKey(identity.line)

  // `player_name` is part of the lookup for the same reason it is part of
  // the unique index: two players' props of the same type at the same line
  // are different markets, and omitting it here would return the first
  // player's market for the second player's price.
  const playerName = identity.playerName ?? ''

  const memoKey = `market:${identity.eventId}:${identity.marketType}:${key}:${period}:${playerName}`
  const known = recall(memoKey)
  if (known !== null)
    return known

  const existing = await db.query(`
    SELECT id FROM markets
    WHERE market_event_id = ? AND market_type = ? AND line_key = ? AND period = ? AND player_name = ?
  `).get(identity.eventId, identity.marketType, key, period, playerName) as { id: number } | null

  if (existing) {
    remember(memoKey, existing.id)
    return existing.id
  }

  const res = await db.prepare(`
    INSERT INTO markets
      (market_event_id, market_type, label, line, line_key, period, player_name, complete, status, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(
    identity.eventId,
    identity.marketType,
    identity.label ?? '',
    identity.line,
    key,
    period,
    playerName,
    identity.complete === false ? 0 : 1,
    identity.position ?? 0,
    nowIso(),
    nowIso(),
  )
  return Number(res.lastInsertRowid)
}

export interface SelectionIdentity {
  marketId: number
  label: string
  side: string
  point: number | null
  position?: number
  sportsTeamId?: number | null
}

/**
 * Find or create a selection. Idempotent on (market, side, point) via the
 * `point_key` unique index.
 *
 * The label is refreshed on every pass but the identity is the side, not
 * the label — which is the whole correction this module exists to make.
 */
export async function resolveSelection(db: Database, identity: SelectionIdentity): Promise<number> {
  const key = lineKey(identity.point)

  const memoKey = `selection:${identity.marketId}:${identity.side}:${key}`
  const known = recall(memoKey)
  if (known !== null)
    return known

  const existing = await db.query(`
    SELECT id FROM selections WHERE market_id = ? AND side = ? AND point_key = ?
  `).get(identity.marketId, identity.side, key) as { id: number } | null

  if (existing) {
    remember(memoKey, existing.id)
    await db.prepare(`
      UPDATE selections SET
        label = ?,
        sports_team_id = COALESCE(?, sports_team_id),
        updated_at = ?
      WHERE id = ?
    `).run(identity.label, identity.sportsTeamId ?? null, nowIso(), existing.id)
    return existing.id
  }

  const res = await db.prepare(`
    INSERT INTO selections
      (market_id, label, side, point, point_key, position, sports_team_id, outcome, graded_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, -1, '', ?, ?)
  `).run(
    identity.marketId,
    identity.label,
    identity.side,
    identity.point,
    key,
    identity.position ?? 0,
    identity.sportsTeamId ?? null,
    nowIso(),
    nowIso(),
  )
  return Number(res.lastInsertRowid)
}
