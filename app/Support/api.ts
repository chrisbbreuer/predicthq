import { openRead } from './db'

/**
 * The API contract: one response envelope, one error vocabulary, one place
 * that parses query parameters.
 *
 * Every endpoint previously invented its own shape. `GET /odds` returned a
 * bare board, `GET /odds/arbitrage` returned `{count, events}`, and
 * `GET /odds/market/{id}` returned `{error, id}` **with HTTP 200** — so a
 * missing market was indistinguishable from a successful response to any
 * client that checked the status code, which is every client. Consistency
 * here is not tidiness; it is the difference between an API a caller can
 * write generic handling against and one they must special-case per route.
 */

/** Machine-readable error codes. Callers branch on these, not on prose. */
export type ErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'internal'

const STATUS_FOR: Record<ErrorCode, number> = {
  not_found: 404,
  invalid_request: 422,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
}

export interface Meta {
  /** When the response was generated. */
  at: string
  /** How fresh the underlying data is, per provider. */
  freshness?: Record<string, string>
  [key: string]: unknown
}

export interface Pagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface SuccessBody<T> {
  data: T
  meta: Meta
  pagination?: Pagination
}

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    /** Field-level detail for validation failures. */
    details?: Record<string, string>
  }
  meta: Meta
}

/**
 * Minimal shape of the framework request object the actions receive.
 *
 * Declared here rather than imported so this module stays usable from a
 * plain test that constructs a fake request.
 */
export interface RequestLike {
  get?: (key: string) => unknown
  header?: (key: string) => unknown
  headers?: Headers | Record<string, unknown>
}

/** Read one request header, whichever accessor the runtime provides. */
export function readHeader(request: RequestLike | undefined, name: string): string | undefined {
  const viaMethod = request?.header?.(name)
  if (typeof viaMethod === 'string')
    return viaMethod

  const headers = request?.headers
  if (headers instanceof Headers)
    return headers.get(name) ?? undefined
  if (headers && typeof headers === 'object') {
    const value = (headers as Record<string, unknown>)[name]
      ?? (headers as Record<string, unknown>)[name.toLowerCase()]
    if (typeof value === 'string')
      return value
  }
  return undefined
}

/**
 * A successful response.
 *
 * Returns a native `Response`, which the router passes through untouched.
 * Returning a plain object instead would have the router JSON-encode it
 * and drop the status and headers entirely — so the envelope would nest
 * inside another one and `cache-control` would never reach the client.
 *
 * `cacheSeconds` drives both `Cache-Control` and the ETag. Odds change
 * every minute and a board a caller believes is current but is not is
 * worse than one served slowly, so the values are short by design — the
 * win is in collapsing the repeated polling a live board generates, not in
 * serving stale prices.
 */
export function ok<T>(
  data: T,
  options: {
    meta?: Partial<Meta>
    pagination?: Pagination
    cacheSeconds?: number
    request?: RequestLike
  } = {},
): Response {
  const body: SuccessBody<T> = {
    data,
    meta: { at: new Date().toISOString(), ...options.meta },
    ...(options.pagination ? { pagination: options.pagination } : {}),
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
  }

  if (options.cacheSeconds && options.cacheSeconds > 0) {
    const etag = weakEtag(body.data)
    headers['cache-control'] = `public, max-age=${options.cacheSeconds}, stale-while-revalidate=${options.cacheSeconds * 2}`
    headers.etag = etag

    // The tag is computed over `data` alone, deliberately excluding
    // `meta.at` — otherwise every response would carry a fresh tag and no
    // conditional request could ever match, which is the usual reason
    // ETags on a live endpoint quietly do nothing.
    const inbound = readHeader(options.request, 'if-none-match')
    if (inbound && inbound.split(',').some(tag => tag.trim() === etag))
      return new Response(null, { status: 304, headers })
  }
  else {
    headers['cache-control'] = 'no-store'
  }

  return Response.json(body, { status: 200, headers })
}

/** An error response, with the status its code implies. */
export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, string>,
): Response {
  const body: ErrorBody = {
    error: { code, message, ...(details ? { details } : {}) },
    meta: { at: new Date().toISOString() },
  }

  return Response.json(body, {
    status: STATUS_FOR[code],
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * A weak ETag over the payload.
 *
 * Weak rather than strong because it hashes the serialized data, not the
 * exact bytes of the response: two responses with identical data but
 * different `meta.at` are semantically equivalent and should share a tag,
 * which is precisely what weak comparison is for.
 */
export function weakEtag(value: unknown): string {
  const json = JSON.stringify(value)
  let h1 = 0x811C9DC5
  let h2 = 0x01000193
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 + c, 2246822519)
  }
  return `W/"${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${json.length.toString(16)}"`
}

/**
 * Typed, validated query-parameter access.
 *
 * Actions previously reached for `request?.get?.('id')` and coerced with a
 * bare `Number()`, so `/odds/market/abc` became `NaN` and fell through to a
 * "not found" that was really a malformed request. Parsing in one place
 * means a bad parameter is reported as a 422 naming the field, rather than
 * silently becoming a different, wrong query.
 */
export class Params {
  private readonly errors: Record<string, string> = {}

  constructor(private readonly request: RequestLike | undefined) {}

  private raw(key: string): string | undefined {
    const value = this.request?.get?.(key)
    if (value === undefined || value === null || value === '')
      return undefined
    return String(value)
  }

  string(key: string, options: { allow?: readonly string[], max?: number } = {}): string | undefined {
    const value = this.raw(key)
    if (value === undefined)
      return undefined

    if (options.allow && !options.allow.includes(value)) {
      this.errors[key] = `must be one of: ${options.allow.join(', ')}`
      return undefined
    }
    if (options.max && value.length > options.max) {
      this.errors[key] = `must be at most ${options.max} characters`
      return undefined
    }
    return value
  }

  int(key: string, options: { min?: number, max?: number, default?: number } = {}): number | undefined {
    const value = this.raw(key)
    if (value === undefined)
      return options.default

    const n = Number(value)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      this.errors[key] = 'must be an integer'
      return options.default
    }
    if (options.min !== undefined && n < options.min) {
      this.errors[key] = `must be at least ${options.min}`
      return options.default
    }
    if (options.max !== undefined && n > options.max) {
      this.errors[key] = `must be at most ${options.max}`
      return options.default
    }
    return n
  }

  /** An ISO-8601 instant. Rejects anything Date cannot parse. */
  instant(key: string): string | undefined {
    const value = this.raw(key)
    if (value === undefined)
      return undefined

    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) {
      this.errors[key] = 'must be an ISO-8601 timestamp'
      return undefined
    }
    return new Date(parsed).toISOString()
  }

  /** The failure response, or null when everything parsed. */
  invalid(): Response | null {
    const keys = Object.keys(this.errors)
    if (keys.length === 0)
      return null
    return fail('invalid_request', `Invalid query parameters: ${keys.join(', ')}`, this.errors)
  }
}

/** Build the pagination block from a total and the window that was served. */
export function paginate(total: number, limit: number, offset: number): Pagination {
  return { total, limit, offset, hasMore: offset + limit < total }
}

/**
 * When each provider last completed a pass.
 *
 * Attached to `meta` so a caller can tell a quiet market from a broken
 * feed without asking. That distinction was previously impossible to make
 * from outside the system, which is how a feed that matched nothing went
 * unnoticed.
 */
export async function freshness(): Promise<Record<string, string>> {
  const db = openRead()
  try {
    const rows = await db.query<{ provider: string, last_success: string }>(`
      SELECT provider, MAX(finished_at) AS last_success
      FROM ingest_runs
      WHERE status IN ('success', 'partial') AND finished_at != ''
      GROUP BY provider
    `).all()

    return Object.fromEntries(rows.map(r => [r.provider, r.last_success]))
  }
  catch {
    // Freshness is context, not payload. A failure to read it must not
    // take down the endpoint whose data is otherwise fine.
    return {}
  }
  finally {
    db.close()
  }
}
