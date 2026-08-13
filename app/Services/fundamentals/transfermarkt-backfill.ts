import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { db } from '@stacksjs/database'
import { norm } from '../../Support/keys'
import {
  parseTransfermarktCareerRecords,
  parseTransfermarktInjuries,
  parseTransfermarktMarketValues,
  parseTransfermarktProfile,
  parseTransfermarktSeasonStats,
  parseTransfermarktSquad,
  parseTransfermarktTransfers,
} from './transfermarkt-dom'
import { parseTransfermarktClubs, TRANSFERMARKT_COMPETITIONS } from './transfermarkt'

const PROVIDER = 'transfermarkt'
const PARSER_VERSION = 'transfermarkt-dom-v1'
const BASE = process.env.TRANSFERMARKT_BASE_URL || 'https://www.transfermarkt.com'
const USER_AGENT = process.env.TRANSFERMARKT_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

type TaskKind = 'competition' | 'squad' | 'profile' | 'transfers' | 'market-values' | 'stats' | 'injuries' | 'achievements' | 'national-team' | 'shirt-numbers' | 'suspensions'

interface TaskPayload {
  sportSlug: string
  teamExternalId?: string
  teamName?: string
  competition?: string
  tier?: number
}

interface TaskRow {
  id: number
  kind: TaskKind
  external_id: string
  url: string
  attempts: number
  payload: string
  lock_token: string
}

interface FetchResult {
  html: string
  hash: string
  fetchedAt: string
  status: number
  contentType: string
  etag: string
  lastModified: string
  storagePath: string
}

export interface TransfermarktBackfillResult {
  seeded: number
  completed: number
  failed: number
  remaining: number
}

export const databaseTimestamp = (date = new Date()): string => date.toISOString().slice(0, 19).replace('T', ' ')
const today = (): string => databaseTimestamp().slice(0, 10)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => await db.unsafe(sql, params).execute() as T[]
const first = async <T>(sql: string, params: unknown[] = []): Promise<T | undefined> => (await rows<T>(sql, params))[0]
const updateOrInsert = async (table: string, match: Record<string, unknown>, values: Record<string, unknown>): Promise<void> => {
  await (db as any).updateOrInsert(table, match, values)
}

function parsePayload(task: TaskRow): TaskPayload {
  try {
    return JSON.parse(task.payload || '{}') as TaskPayload
  }
  catch {
    throw new Error(`Backfill task ${task.id} has invalid JSON payload`)
  }
}

function canonicalPlayerUrl(externalId: string, kind: TaskKind, profileUrl: string): string {
  if (kind === 'profile') return profileUrl
  const segment: Record<Exclude<TaskKind, 'competition' | 'squad' | 'profile'>, string> = {
    transfers: 'transfers',
    'market-values': 'marktwertverlauf',
    stats: 'leistungsdatendetails',
    injuries: 'verletzungen',
    achievements: 'erfolge',
    'national-team': 'nationalmannschaft',
    'shirt-numbers': 'rueckennummern',
    suspensions: 'sperren',
  }
  const path = segment[kind as keyof typeof segment]
  return `${BASE}/${path}/spieler/${externalId}${kind === 'stats' ? '/plus/1' : ''}`
}

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'club'
}

function normalizeDate(value: string): string {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 20) : parsed.toISOString().slice(0, 10)
}

function blockedHtml(html: string): boolean {
  return /captcha|access denied|unusual traffic|automated (?:access|requests)|cf-chl-/i.test(html.slice(0, 100_000))
}

let lastRequestAt = 0

async function fetchAndSnapshot(task: TaskRow): Promise<FetchResult> {
  const minimumDelay = Math.max(0, Number(process.env.TRANSFERMARKT_MIN_DELAY_MS || 1800))
  const jitter = Math.max(0, Number(process.env.TRANSFERMARKT_DELAY_JITTER_MS || 500))
  const wait = lastRequestAt + minimumDelay + Math.floor(Math.random() * (jitter + 1)) - Date.now()
  if (wait > 0) await Bun.sleep(wait)

  const headers: Record<string, string> = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': process.env.TRANSFERMARKT_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'user-agent': USER_AGENT,
  }
  if (process.env.TRANSFERMARKT_COOKIE)
    headers.cookie = process.env.TRANSFERMARKT_COOKIE

  const response = await fetch(task.url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.TRANSFERMARKT_TIMEOUT_MS || 30_000))),
  })
  lastRequestAt = Date.now()
  const html = await response.text()
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok)
    throw new Error(`Transfermarkt returned HTTP ${response.status} for ${task.url}`)
  if (!contentType.toLowerCase().includes('text/html'))
    throw new Error(`Transfermarkt returned ${contentType || 'an unknown content type'} instead of HTML`)
  if (blockedHtml(html))
    throw new Error('Transfermarkt returned an access challenge; provide your browser session cookie or retry later')

  const hash = sha256(html)
  const storagePath = join('storage', 'ingest', PROVIDER, hash.slice(0, 2), `${hash}.html`)
  const absolutePath = join(process.cwd(), storagePath)
  if (!existsSync(absolutePath)) {
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, html, { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }

  const fetchedAt = databaseTimestamp()
  await updateOrInsert('source_documents', {
    provider: PROVIDER,
    url_hash: sha256(task.url),
    content_hash: hash,
  }, {
    kind: task.kind,
    external_id: task.external_id,
    url: task.url,
    storage_path: storagePath,
    http_status: response.status,
    content_type: contentType,
    etag: response.headers.get('etag') || '',
    last_modified: response.headers.get('last-modified') || '',
    byte_length: Buffer.byteLength(html),
    fetched_at: fetchedAt,
    parser_version: PARSER_VERSION,
    updated_at: fetchedAt,
  })

  return {
    html,
    hash,
    fetchedAt,
    status: response.status,
    contentType,
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
    storagePath,
  }
}

async function enqueue(kind: TaskKind, externalId: string, url: string, payload: TaskPayload, priority: number, refreshHours = 0): Promise<boolean> {
  const existing = await first<{ id: number, status: string, completed_at: string }>(
    'SELECT id, status, completed_at FROM backfill_tasks WHERE provider = ? AND kind = ? AND external_id = ? LIMIT 1',
    [PROVIDER, kind, externalId],
  )
  const timestamp = databaseTimestamp()
  if (!existing) {
    await (db as any).insertOrIgnore('backfill_tasks', {
      provider: PROVIDER,
      kind,
      external_id: externalId,
      url,
      status: 'pending',
      priority,
      attempts: 0,
      available_at: '',
      locked_at: '',
      lock_token: '',
      completed_at: '',
      last_error: '',
      document_hash: '',
      payload: JSON.stringify(payload),
      created_at: timestamp,
      updated_at: timestamp,
    })
    return true
  }

  const completedAt = Date.parse(existing.completed_at || '')
  const stale = refreshHours > 0 && (!Number.isFinite(completedAt) || completedAt <= Date.now() - refreshHours * 3_600_000)
  await db.updateTable('backfill_tasks').set({
    url,
    payload: JSON.stringify(payload),
    priority,
    ...(existing.status === 'completed' && stale
      ? { status: 'pending', available_at: '', completed_at: '', last_error: '' }
      : {}),
    updated_at: timestamp,
  }).where('id', '=', existing.id).execute()
  return existing.status === 'completed' && stale
}

export async function seedTransfermarktBackfill(refresh = false): Promise<number> {
  let seeded = 0
  for (const target of TRANSFERMARKT_COMPETITIONS) {
    const url = `${BASE}/${target.path}/startseite/wettbewerb/${target.externalId}`
    if (await enqueue('competition', target.externalId, url, { sportSlug: target.sportSlug, competition: target.label, tier: target.tier }, 10, refresh ? 20 : 0))
      seeded++
  }
  return seeded
}

async function sportId(slug: string): Promise<number> {
  const sport = await first<{ id: number }>('SELECT id FROM sports WHERE slug = ? LIMIT 1', [slug])
  if (!sport) throw new Error(`Sport ${slug} is not seeded`)
  return Number(sport.id)
}

async function ensureTeam(sport: number, externalId: string, name: string, canonicalUrl = ''): Promise<number> {
  if (!externalId) return 0
  const identity = await first<{ sports_team_id: number }>(
    'SELECT sports_team_id FROM team_identities WHERE provider = ? AND external_id = ? LIMIT 1',
    [PROVIDER, externalId],
  )
  const timestamp = databaseTimestamp()
  let teamId = Number(identity?.sports_team_id || 0)
  if (!teamId) {
    const searchKey = norm(name)
    const existing = searchKey
      ? await first<{ id: number }>('SELECT id FROM sports_teams WHERE sport_id = ? AND search_key = ? LIMIT 1', [sport, searchKey])
      : undefined
    teamId = Number(existing?.id || 0)
    if (!teamId) {
      teamId = Number(await (db as any).insertGetId('sports_teams', {
        sport_id: sport,
        name: name || `Transfermarkt club ${externalId}`,
        search_key: searchKey || `transfermarkt${externalId}`,
        short_name: '',
        abbreviation: '',
        aliases: '',
        logo: '',
        espn_id: '',
        record: '',
        created_at: timestamp,
        updated_at: timestamp,
      }))
    }
  }
  await updateOrInsert('team_identities', { provider: PROVIDER, external_id: externalId }, {
    sports_team_id: teamId,
    canonical_url: canonicalUrl,
    external_name: name,
    last_seen_at: timestamp,
    updated_at: timestamp,
  })
  return teamId
}

async function ensureAthlete(sport: number, externalId: string, name: string, profileUrl: string, values: Record<string, unknown> = {}): Promise<number> {
  const identity = await first<{ athlete_id: number }>(
    'SELECT athlete_id FROM athlete_identities WHERE provider = ? AND external_id = ? LIMIT 1',
    [PROVIDER, externalId],
  )
  const timestamp = databaseTimestamp()
  let athleteId = Number(identity?.athlete_id || 0)
  if (!athleteId) {
    athleteId = Number(await (db as any).insertGetId('athletes', {
      sport_id: sport,
      name: name || `Transfermarkt player ${externalId}`,
      search_key: norm(name) || `transfermarkt${externalId}`,
      given_name: '',
      family_name: '',
      date_of_birth: '',
      place_of_birth: '',
      nationality: '',
      second_nationality: '',
      position: '',
      secondary_positions: '[]',
      height_cm: 0,
      preferred_foot: '',
      shirt_number: 0,
      joined_on: '',
      contract_expires_on: '',
      agent_name: '',
      outfitter: '',
      status: 'active',
      image_url: '',
      last_seen_at: timestamp,
      ...values,
      created_at: timestamp,
      updated_at: timestamp,
    }))
  }
  else {
    await db.updateTable('athletes').set({ ...values, name, search_key: norm(name), last_seen_at: timestamp, updated_at: timestamp }).where('id', '=', athleteId).execute()
  }
  await updateOrInsert('athlete_identities', { provider: PROVIDER, external_id: externalId }, {
    athlete_id: athleteId,
    canonical_url: profileUrl,
    external_name: name,
    aliases: '[]',
    last_seen_at: timestamp,
    updated_at: timestamp,
  })
  return athleteId
}

async function handleCompetition(task: TaskRow, html: string): Promise<void> {
  const payload = parsePayload(task)
  const sport = await sportId(payload.sportSlug)
  const clubs = parseTransfermarktClubs(html)
  if (clubs.length === 0) throw new Error('Transfermarkt competition DOM contained no club rows')
  const capturedAt = today()
  for (const club of clubs) {
    const clubSlug = slugify(club.name)
    const canonicalUrl = `${BASE}/${clubSlug}/startseite/verein/${club.externalId}`
    const teamId = await ensureTeam(sport, club.externalId, club.name, canonicalUrl)
    await updateOrInsert('club_valuations', {
      sports_team_id: teamId,
      source: PROVIDER,
      external_id: club.externalId,
      captured_at: capturedAt,
    }, {
      squad_value_eur: club.marketValueEur,
      squad_size: club.squadSize,
      average_age_years: club.averageAgeYears,
      league_tier: payload.tier || 0,
      competition: payload.competition || '',
      updated_at: databaseTimestamp(),
    })
    await enqueue('squad', `${payload.sportSlug}:${club.externalId}`, `${BASE}/${clubSlug}/kader/verein/${club.externalId}/plus/1`, {
      ...payload,
      teamExternalId: club.externalId,
      teamName: club.name,
    }, 20, 20)
  }
}

async function handleSquad(task: TaskRow, html: string): Promise<void> {
  const payload = parsePayload(task)
  const sport = await sportId(payload.sportSlug)
  const teamId = await ensureTeam(sport, payload.teamExternalId || '', payload.teamName || '')
  const players = parseTransfermarktSquad(html)
  if (players.length === 0) throw new Error('Transfermarkt squad DOM contained no player rows')
  for (const player of players) {
    const athleteId = await ensureAthlete(sport, player.externalId, player.name, player.profileUrl, {
      sports_team_id: teamId || null,
      date_of_birth: normalizeDate(player.dateOfBirth),
      nationality: player.nationality,
      position: player.position,
    })
    if (teamId) {
      await updateOrInsert('athlete_team_memberships', { athlete_id: athleteId, sports_team_id: teamId, started_on: '' }, {
        ended_on: '', squad_number: 0, role: 'player', competition: payload.competition || '', source: PROVIDER, updated_at: databaseTimestamp(),
      })
    }
    if (player.marketValueEur > 0) {
      await updateOrInsert('athlete_market_values', { athlete_id: athleteId, provider: PROVIDER, valued_on: today() }, {
        value_eur: player.marketValueEur, team_name: payload.teamName || '', updated_at: databaseTimestamp(),
      })
    }
    const childPayload = { ...payload, teamExternalId: payload.teamExternalId, teamName: payload.teamName }
    await enqueue('profile', player.externalId, canonicalPlayerUrl(player.externalId, 'profile', player.profileUrl), childPayload, 30, 24 * 30)
    await enqueue('injuries', player.externalId, canonicalPlayerUrl(player.externalId, 'injuries', player.profileUrl), childPayload, 40, 24)
    await enqueue('stats', player.externalId, canonicalPlayerUrl(player.externalId, 'stats', player.profileUrl), childPayload, 50, 24 * 7)
    await enqueue('market-values', player.externalId, canonicalPlayerUrl(player.externalId, 'market-values', player.profileUrl), childPayload, 60, 24 * 30)
    await enqueue('transfers', player.externalId, canonicalPlayerUrl(player.externalId, 'transfers', player.profileUrl), childPayload, 70, 24 * 30)
    await enqueue('national-team', player.externalId, canonicalPlayerUrl(player.externalId, 'national-team', player.profileUrl), childPayload, 80, 24 * 7)
    await enqueue('achievements', player.externalId, canonicalPlayerUrl(player.externalId, 'achievements', player.profileUrl), childPayload, 90, 24 * 30)
    await enqueue('shirt-numbers', player.externalId, canonicalPlayerUrl(player.externalId, 'shirt-numbers', player.profileUrl), childPayload, 100, 24 * 30)
    await enqueue('suspensions', player.externalId, canonicalPlayerUrl(player.externalId, 'suspensions', player.profileUrl), childPayload, 110, 24)
  }
}

async function athleteFor(task: TaskRow): Promise<{ athleteId: number, sport: number, payload: TaskPayload }> {
  const payload = parsePayload(task)
  const sport = await sportId(payload.sportSlug)
  const identity = await first<{ athlete_id: number }>('SELECT athlete_id FROM athlete_identities WHERE provider = ? AND external_id = ? LIMIT 1', [PROVIDER, task.external_id])
  if (!identity) throw new Error(`Transfermarkt athlete ${task.external_id} has no canonical identity`)
  return { athleteId: Number(identity.athlete_id), sport, payload }
}

async function handleProfile(task: TaskRow, html: string): Promise<void> {
  const { athleteId, sport, payload } = await athleteFor(task)
  const profile = parseTransfermarktProfile(html)
  if (!profile.name) throw new Error('Transfermarkt profile DOM contained no player name')
  const currentTeamId = profile.currentTeamExternalId
    ? await ensureTeam(sport, profile.currentTeamExternalId, profile.currentTeamName)
    : 0
  await ensureAthlete(sport, task.external_id, profile.name, task.url, {
    sports_team_id: currentTeamId || null,
    date_of_birth: normalizeDate(profile.dateOfBirth),
    place_of_birth: profile.placeOfBirth,
    nationality: profile.nationality,
    second_nationality: profile.secondNationality,
    position: profile.position,
    secondary_positions: JSON.stringify(profile.secondaryPositions),
    height_cm: profile.heightCm,
    preferred_foot: profile.preferredFoot,
    shirt_number: profile.shirtNumber,
    joined_on: normalizeDate(profile.joinedOn),
    contract_expires_on: normalizeDate(profile.contractExpiresOn),
    agent_name: profile.agentName,
    outfitter: profile.outfitter,
    image_url: profile.imageUrl,
  })
  await db.updateTable('athlete_identities').set({
    profile_facts: JSON.stringify(profile.facts),
    updated_at: databaseTimestamp(),
  }).where('provider', '=', PROVIDER).where('external_id', '=', task.external_id).execute()
  if (currentTeamId) {
    await updateOrInsert('athlete_team_memberships', { athlete_id: athleteId, sports_team_id: currentTeamId, started_on: '' }, {
      ended_on: '', squad_number: profile.shirtNumber, role: 'player', competition: payload.competition || '', source: PROVIDER, updated_at: databaseTimestamp(),
    })
  }
  if (profile.marketValueEur > 0) {
    await updateOrInsert('athlete_market_values', { athlete_id: athleteId, provider: PROVIDER, valued_on: today() }, {
      value_eur: profile.marketValueEur, team_name: profile.currentTeamName, updated_at: databaseTimestamp(),
    })
  }
}

async function handleTransfers(task: TaskRow, html: string): Promise<void> {
  const { athleteId, sport } = await athleteFor(task)
  for (const transfer of parseTransfermarktTransfers(html)) {
    const fromTeamId = await ensureTeam(sport, transfer.fromTeamExternalId, transfer.fromTeamName)
    const toTeamId = await ensureTeam(sport, transfer.toTeamExternalId, transfer.toTeamName)
    const transferredOn = normalizeDate(transfer.transferredOn)
    await updateOrInsert('athlete_transfers', { athlete_id: athleteId, provider: PROVIDER, external_id: transfer.externalId }, {
      from_sports_team_id: fromTeamId,
      to_sports_team_id: toTeamId,
      from_team_name: transfer.fromTeamName,
      to_team_name: transfer.toTeamName,
      kind: transfer.kind,
      season: transfer.season,
      transferred_on: transferredOn,
      fee_eur: transfer.feeEur,
      market_value_eur: transfer.marketValueEur,
      updated_at: databaseTimestamp(),
    })
    if (toTeamId) {
      await updateOrInsert('athlete_team_memberships', { athlete_id: athleteId, sports_team_id: toTeamId, started_on: transferredOn }, {
        ended_on: '', squad_number: 0, role: 'player', competition: '', source: PROVIDER, updated_at: databaseTimestamp(),
      })
    }
  }
}

async function handleMarketValues(task: TaskRow, html: string): Promise<void> {
  const { athleteId } = await athleteFor(task)
  for (const value of parseTransfermarktMarketValues(html)) {
    await updateOrInsert('athlete_market_values', { athlete_id: athleteId, provider: PROVIDER, valued_on: normalizeDate(value.valuedOn) }, {
      value_eur: value.valueEur, team_name: value.teamName, updated_at: databaseTimestamp(),
    })
  }
}

async function handleStats(task: TaskRow, html: string): Promise<void> {
  const { athleteId, sport } = await athleteFor(task)
  for (const stat of parseTransfermarktSeasonStats(html)) {
    const teamId = await ensureTeam(sport, stat.teamExternalId, stat.teamName)
    await updateOrInsert('athlete_season_stats', {
      athlete_id: athleteId,
      provider: PROVIDER,
      season: stat.season,
      competition: stat.competition,
      sports_team_id: teamId,
    }, {
      appearances: stat.appearances,
      starts: Number(stat.metrics.starts || 0),
      minutes: stat.minutes,
      points: Number(stat.metrics.points || 0),
      goals: stat.goals,
      assists: stat.assists,
      metrics: JSON.stringify(stat.metrics),
      updated_at: databaseTimestamp(),
    })
  }
}

async function handleInjuries(task: TaskRow, html: string): Promise<void> {
  const { athleteId } = await athleteFor(task)
  for (const injury of parseTransfermarktInjuries(html)) {
    const startedOn = normalizeDate(injury.startedOn)
    await updateOrInsert('athlete_injuries', { athlete_id: athleteId, provider: PROVIDER, started_on: startedOn, injury_type: injury.injuryType }, {
      ended_on: normalizeDate(injury.endedOn),
      days_missed: injury.daysMissed,
      games_missed: injury.gamesMissed,
      status: injury.endedOn ? 'resolved' : 'active',
      updated_at: databaseTimestamp(),
    })
  }
}

async function handleCareerRecords(task: TaskRow, html: string): Promise<void> {
  const { athleteId, sport } = await athleteFor(task)
  for (const record of parseTransfermarktCareerRecords(html, task.kind)) {
    const teamId = await ensureTeam(sport, record.teamExternalId, record.teamName)
    await updateOrInsert('athlete_career_records', {
      athlete_id: athleteId,
      provider: PROVIDER,
      category: task.kind,
      external_id: record.externalId,
    }, {
      title: record.title,
      season: record.season,
      competition: record.competition,
      sports_team_id: teamId,
      team_name: record.teamName,
      occurred_on: normalizeDate(record.occurredOn),
      ended_on: normalizeDate(record.endedOn),
      details: JSON.stringify(record.details),
      updated_at: databaseTimestamp(),
    })
  }
}

async function handleTask(task: TaskRow, html: string): Promise<void> {
  if (task.kind === 'competition') return await handleCompetition(task, html)
  if (task.kind === 'squad') return await handleSquad(task, html)
  if (task.kind === 'profile') return await handleProfile(task, html)
  if (task.kind === 'transfers') return await handleTransfers(task, html)
  if (task.kind === 'market-values') return await handleMarketValues(task, html)
  if (task.kind === 'stats') return await handleStats(task, html)
  if (task.kind === 'injuries') return await handleInjuries(task, html)
  if (task.kind === 'achievements' || task.kind === 'national-team' || task.kind === 'shirt-numbers' || task.kind === 'suspensions')
    return await handleCareerRecords(task, html)
  throw new Error(`Unsupported Transfermarkt task kind: ${String(task.kind)}`)
}

async function claimTask(): Promise<TaskRow | undefined> {
  const timestamp = databaseTimestamp()
  const staleBefore = databaseTimestamp(new Date(Date.now() - 30 * 60_000))
  await db.unsafe(
    `UPDATE backfill_tasks SET status = 'pending', locked_at = '', lock_token = '', available_at = '', updated_at = ?
    WHERE provider = ? AND status = 'running' AND locked_at <> '' AND locked_at < ?`,
    [timestamp, PROVIDER, staleBefore],
  ).execute()
  const candidates = await rows<TaskRow>(
    `SELECT id, kind, external_id, url, attempts, payload
    FROM backfill_tasks
    WHERE provider = ? AND status IN ('pending', 'failed') AND attempts < ? AND (available_at = '' OR available_at <= ?)
    ORDER BY priority ASC, id ASC LIMIT 10`,
    [PROVIDER, Math.max(1, Number(process.env.TRANSFERMARKT_MAX_ATTEMPTS || 8)), timestamp],
  )
  for (const candidate of candidates) {
    const token = randomUUID()
    await db.unsafe(
      `UPDATE backfill_tasks SET status = 'running', locked_at = ?, lock_token = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'failed')`,
      [timestamp, token, timestamp, candidate.id],
    ).execute()
    const claimed = await first<TaskRow>(
      'SELECT id, kind, external_id, url, attempts, payload, lock_token FROM backfill_tasks WHERE id = ? LIMIT 1',
      [candidate.id],
    )
    if (claimed?.lock_token === token) return claimed
  }
  return undefined
}

async function finishTask(task: TaskRow, fetchResult: FetchResult): Promise<void> {
  const timestamp = databaseTimestamp()
  await db.updateTable('backfill_tasks').set({
    status: 'completed',
    locked_at: '',
    lock_token: '',
    available_at: '',
    completed_at: timestamp,
    last_error: '',
    document_hash: fetchResult.hash,
    updated_at: timestamp,
  }).where('id', '=', task.id).where('lock_token', '=', task.lock_token).execute()
  await db.updateTable('source_documents').set({ parsed_at: timestamp, parser_version: PARSER_VERSION, updated_at: timestamp })
    .where('provider', '=', PROVIDER)
    .where('url_hash', '=', sha256(task.url))
    .where('content_hash', '=', fetchResult.hash)
    .execute()
}

async function failTask(task: TaskRow, error: unknown): Promise<void> {
  const attempts = Math.max(1, Number(task.attempts || 0))
  const exhausted = attempts >= Math.max(1, Number(process.env.TRANSFERMARKT_MAX_ATTEMPTS || 8))
  const delay = Math.min(24 * 3_600_000, 60_000 * 2 ** Math.min(10, attempts - 1))
  const timestamp = databaseTimestamp()
  await db.updateTable('backfill_tasks').set({
    status: exhausted ? 'exhausted' : 'failed',
    locked_at: '',
    lock_token: '',
    available_at: databaseTimestamp(new Date(Date.now() + delay)),
    last_error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    updated_at: timestamp,
  }).where('id', '=', task.id).where('lock_token', '=', task.lock_token).execute()
}

export async function runTransfermarktBackfill(options: { limit?: number, seed?: boolean, refresh?: boolean } = {}): Promise<TransfermarktBackfillResult> {
  const limit = Math.max(0, Math.min(10_000, Number(options.limit ?? 25)))
  const seeded = options.seed === false ? 0 : await seedTransfermarktBackfill(Boolean(options.refresh))
  let completed = 0
  let failed = 0
  for (let index = 0; index < limit; index++) {
    const task = await claimTask()
    if (!task) break
    try {
      const fetched = await fetchAndSnapshot(task)
      await handleTask(task, fetched.html)
      await finishTask(task, fetched)
      completed++
    }
    catch (error) {
      await failTask(task, error)
      failed++
      console.error(`[transfermarkt] ${task.kind}:${task.external_id} failed:`, error instanceof Error ? error.message : error)
    }
  }
  const remainingRow = await first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM backfill_tasks WHERE provider = ? AND status <> 'completed'`,
    [PROVIDER],
  )
  return { seeded, completed, failed, remaining: Number(remainingRow?.count || 0) }
}
