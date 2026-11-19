import { ok } from '../../Support/api'

/**
 * GET /api/v1/openapi — the machine-readable contract.
 *
 * Hand-written rather than generated. The generated alternative describes
 * the *shape* of a response but not the part that actually matters here:
 * that `fairProb` is de-vigged and `bestImpliedPct` is not, that arbitrage
 * is per market rather than per event, and that a training set must be
 * split chronologically. Those are the facts a consumer gets wrong, and
 * they only survive in a spec someone wrote on purpose.
 */

const COMMON_PARAMS = {
  limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
  offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  sport: { name: 'sport', in: 'query', description: 'Sport slug, e.g. nba', schema: { type: 'string' } },
  market: { name: 'market', in: 'query', schema: { type: 'string', enum: ['h2h', 'spreads', 'totals'] } },
}

const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'OddsBeacon API',
    version: '1.0.0',
    description: [
      'Odds comparison, de-vigged fair pricing, and labelled training data.',
      '',
      'Two probability figures appear throughout and they are not interchangeable.',
      '`bestImpliedPct` is 1/price and still contains the bookmaker margin.',
      '`fairProb` has that margin removed and is the only one an edge should be',
      'computed against. Comparing a price to an implied probability measures vig,',
      'not value.',
      '',
      'Endpoints accept an API key and are metered when one is presented. `/training`',
      'requires one: it returns thousands of rows a call, and serving that to a caller',
      'nobody can name is a question of who holds the data rather than of rate limits.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description: [
          'A key issued under your account, sent as `Authorization: Bearer phq_...`.',
          'Optional on every endpoint but `/training`, which requires one. Presenting',
          'a key raises your allowance to the daily quota of your plan and meters the',
          'requests against it; without one the per-address rate limit applies.',
        ].join(' '),
      },
    },
    schemas: {
      Meta: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
          freshness: {
            type: 'object',
            additionalProperties: { type: 'string', format: 'date-time' },
            description: 'When each ingestion provider last completed a pass. Use it to tell a quiet market from a stalled feed.',
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          hasMore: { type: 'boolean' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: ['not_found', 'invalid_request', 'unauthorized', 'forbidden', 'rate_limited', 'unavailable', 'internal'],
              },
              message: { type: 'string' },
              details: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
          meta: { $ref: '#/components/schemas/Meta' },
        },
      },
      Edge: {
        type: 'object',
        properties: {
          selectionId: { type: 'integer' },
          bestPrice: { type: 'number', description: 'Best decimal price across all books.' },
          fairProb: { type: 'number', description: 'De-vigged consensus probability, 0..1.' },
          sharpProb: { type: 'number', description: 'Fair probability from sharp books only. 0 when none quote it.' },
          edgePct: { type: 'number', description: '(bestPrice * fairProb - 1) * 100.' },
          kellyFraction: { type: 'number', description: 'Quarter-Kelly stake fraction. Never negative.' },
          confidence: {
            type: 'object',
            description: 'How much to trust the edge. A large edge from few books with high methodSpread is usually an artifact.',
            properties: {
              bookCount: { type: 'integer' },
              sharpBookCount: { type: 'integer' },
              methodSpread: { type: 'number', description: 'Disagreement between the three de-vig methods.' },
              overroundPct: { type: 'number' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/status': {
      get: {
        summary: 'Ingestion health, per-provider freshness, and row counts',
        description: 'A provider whose last successful pass is over an hour old is reported as degraded.',
        responses: { 200: { description: 'Current status' } },
      },
    },
    '/odds': {
      get: {
        summary: 'The comparison board',
        parameters: [
          COMMON_PARAMS.sport,
          COMMON_PARAMS.market,
          COMMON_PARAMS.limit,
          COMMON_PARAMS.offset,
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['scheduled', 'live', 'final', 'postponed', 'cancelled'] } },
          { name: 'from', in: 'query', description: 'ISO-8601 lower bound on kickoff.', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'history', in: 'query', description: 'Sparkline points per selection. 0 skips the history query.', schema: { type: 'integer', default: 30 } },
        ],
        responses: {
          200: { description: 'Board page' },
          422: { description: 'Invalid parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/events/{id}': {
      get: {
        summary: 'One event with every market on it',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'The event' },
          404: { description: 'No such event', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/events/{id}/markets': {
      get: {
        summary: 'Which bookmakers offer which markets on an event',
        description:
          'What each book *offers*, as opposed to what it is currently pricing. The two differ in the case '
          + 'that matters: a book that pulled a market and a book that never had it both show no prices through '
          + '/events/{id}, and only the first is a market closing. `lastSeenAt` is what separates them.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'Coverage, grouped by bookmaker' },
          404: { description: 'No coverage recorded for that event', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/historical/odds': {
      get: {
        summary: 'The board as it stood at a given instant',
        description:
          'Reconstructed rather than looked up: price history is a change log, so a row exists only where a '
          + 'price moved and the board at an instant is the latest observation at or before it, per selection '
          + 'and book. A timestamp in the future is refused rather than quietly answered with the current board.',
        parameters: [
          { name: 'date', in: 'query', required: true, description: 'ISO-8601 instant to reconstruct at.', schema: { type: 'string', format: 'date-time' } },
          COMMON_PARAMS.sport,
          { name: 'maxAgeMinutes', in: 'query', description: 'Return recorded sportsbook observations within this age, including unchanged quotes.', schema: { type: 'integer', minimum: 1, maximum: 60 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
        ],
        responses: {
          200: { description: 'Quotes as they stood' },
          422: { description: 'Missing or invalid date', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/edges': {
      get: {
        summary: 'Selections whose best price beats de-vigged fair value',
        description: 'Ranked by edge descending. minBooks defaults to 3 because a one-book "consensus" is not one.',
        parameters: [
          { name: 'minEdge', in: 'query', description: 'Minimum edge percent.', schema: { type: 'integer', default: 1 } },
          { name: 'minBooks', in: 'query', schema: { type: 'integer', default: 3 } },
          COMMON_PARAMS.sport,
          COMMON_PARAMS.market,
          COMMON_PARAMS.limit,
          COMMON_PARAMS.offset,
        ],
        responses: {
          200: {
            description: 'Edges',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Edge' } },
                    meta: { $ref: '#/components/schemas/Meta' },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/arbitrage': {
      get: {
        summary: 'Markets where line-shopping guarantees a profit',
        description: 'Computed per market, never per event: only selections within one market at one line are mutually exclusive. Never cached, because arbitrage windows close in seconds.',
        parameters: [
          COMMON_PARAMS.sport,
          { name: 'minProfit', in: 'query', schema: { type: 'integer', default: 0 } },
          COMMON_PARAMS.limit,
        ],
        responses: { 200: { description: 'Opportunities, each with per-leg stake shares' } },
      },
    },
    '/movements': {
      get: {
        summary: 'Recent line moves across every book',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 40, maximum: 200 } }],
        responses: { 200: { description: 'Moves, newest first' } },
      },
    },
    '/calibration': {
      get: {
        summary: 'Reliability curve for the fair-value model',
        description: 'Empty until enough markets have settled. Brier and log loss are sample-weighted across buckets.',
        parameters: [
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['overall', 'sport', 'market_type'], default: 'overall' } },
          { name: 'key', in: 'query', description: 'Sport slug or market type when scope is not overall.', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Buckets and aggregate scores' } },
      },
    },
    '/training': {
      get: {
        summary: 'Labelled pre-kickoff feature vectors',
        security: [{ apiKey: [] }],
        description: 'Features are frozen at capture time and never recomputed, so they contain no information a live caller would not have had. Split train and test chronologically on capturedAt — a random split leaks rows from the same event across both sides.',
        parameters: [
          COMMON_PARAMS.sport,
          COMMON_PARAMS.market,
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'includeUnlabelled', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'false' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 5000 } },
          COMMON_PARAMS.offset,
        ],
        responses: { 200: { description: 'Feature rows with labels and CLV' } },
      },
    },
  },
} as const

export default {
  name: 'V1GetOpenApi',
  description: 'The OpenAPI 3.1 description of this API.',

  async handle() {
    // The contract only changes on deploy, so it caches for an hour.
    return ok(SPEC, { cacheSeconds: 3600 })
  },
}
