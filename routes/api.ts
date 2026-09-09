import { route } from '@stacksjs/router'

/**
 * Unversioned API routes, served under `/api`.
 *
 * The odds endpoints here are aliases onto the v1 actions. They exist so
 * the pages and any existing client keep working; new integrations should
 * use `/api/v1/*`, where the response envelope is stable and the contract
 * is documented at `/api/v1/openapi`.
 *
 * @see routes/v1.ts for the versioned surface and its rate limits.
 */

// ---- Odds: aliases onto v1 -------------------------------------------------
// Answers from its dependencies rather than from a literal: an instance
// that cannot reach its database has to fail this, or a load balancer
// keeps routing to it. See app/Services/health.ts.
route.get('/health', 'Actions/GetHealth')

route.group({ middleware: ['auth', 'throttle:30,1'] }, () => {
  route.get('/groups', 'Actions/Groups/ListGroups')
  route.post('/groups', 'Actions/Groups/CreateGroup')
  route.post('/groups/invitations/accept', 'Actions/Groups/AcceptGroupInvitation')
  route.get('/groups/{id}', 'Actions/Groups/GetGroup')
  route.post('/groups/{id}/invitations', 'Actions/Groups/InviteToGroup')
  route.delete('/groups/{id}/invitations/{invitationId}', 'Actions/Groups/RevokeGroupInvitation')
  route.delete('/groups/{id}/members/{userId}', 'Actions/Groups/RemoveGroupMember')
})
route.get('/odds', 'Actions/V1/GetBoard')
route.get('/odds/arbitrage', 'Actions/V1/GetArbitrage')
route.get('/odds/edges', 'Actions/V1/GetEdges')
route.get('/odds/movements', 'Actions/V1/GetMovements')
route.get('/odds/market/{id}', 'Actions/V1/GetEvent')
route.get('/odds/book/{slug}', 'Actions/Odds/GetBookmaker')

// ---- Prediction markets ----------------------------------------------------
route.get('/markets/smart-money', 'Actions/PredictionMarkets/GetSmartMoney')
route.get('/markets/whales', 'Actions/PredictionMarkets/GetWhaleTrades')
route.get('/markets/graph', 'Actions/PredictionMarkets/GetSignalGraph')

// ---- Bet sheets (signed-in user or an anon token) --------------------------
// These accept an anonymous token rather than a session, so there is no
// account to hold responsible for a flood — the rate limit is the only
// thing standing between an anonymous caller and unbounded rows.
route.group({ middleware: ['throttle:60,1'] }, () => {
  route.get('/sheets', 'Actions/Sheets/ListSheets')
  route.post('/sheets', 'Actions/Sheets/SaveSheet')
  route.delete('/sheets/{id}', 'Actions/Sheets/DeleteSheet')
})

// ---- API keys --------------------------------------------------------------
// Managed with a session, never with a key: a key that can mint another
// key turns one leak into permanent access.
route.group({ middleware: ['auth', 'throttle:30,1'] }, () => {
  route.get('/keys', 'Actions/ApiKeys/ListApiKeys')
  route.post('/keys', 'Actions/ApiKeys/CreateApiKey')
  route.delete('/keys/{id}', 'Actions/ApiKeys/RevokeApiKey')
})

// ---- Alert subscriptions ---------------------------------------------------
// Standing requests to be told about something. Authenticated, because
// an alert has to reach a person and an anonymous token is not one.
route.group({ middleware: ['auth', 'throttle:60,1'] }, () => {
  route.get('/alerts/subscriptions', 'Actions/Alerts/ListSubscriptions')
  route.post('/alerts/subscriptions', 'Actions/Alerts/SaveSubscription')
  route.delete('/alerts/subscriptions/{id}', 'Actions/Alerts/DeleteSubscription')
})

// ---- Community -------------------------------------------------------------
// User-authored text that other people read. Tighter than the sheets:
// posting is the one write here whose output is public.
route.group({ middleware: ['throttle:20,1'] }, () => {
  route.post('/community/notes', 'Actions/Community/PostNote')
})

// `/coming-soon` is served as an STX view from
// `storage/framework/defaults/resources/views/coming-soon.stx`. The view
// auto-resolves through stx-serve, so no route registration is needed here.
// To activate the holding page across the whole app:
//
//   ./buddy coming-soon [--secret=my-magic-token]
//
// Launch the site with `./buddy launch`. Maintenance mode (503 page,
// distinct cookie + state file) is the separate `./buddy down` / `./buddy up`
// pair.
