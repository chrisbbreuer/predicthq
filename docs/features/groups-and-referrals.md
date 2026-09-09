# Groups and referrals

Visit `/groups` to create a private group, view members, create an invitation, or get a personal referral link. Owners can revoke invitations and remove members; members can leave. Links expire after seven days and can be used once. An optional email restriction must match the accepting account. Invitations are shared manually, and only their SHA-256 hash is stored.

PredictHQ uses the native referral implementation from `stacks@0.74.32` (`@stacksjs/auth`). Referral and ReferralCode are published framework model definitions. New social registrations attribute the code inside the registration transaction; existing accounts cannot claim a referral. The OAuth context is bound to the verified state cookie. A successful exchange connection qualifies the referral once. Referrers receive aggregate counts, never another user's email or account details. No monetary rewards are promised.

Production deployment applies committed migrations with `migrate --no-generate`. The new migrations create only prediction_groups, group_members, group_invitations, referral_codes, and referrals. SQLite and unsharded Vitess migrations are included.

# Exchange connections

`/account` supports Kalshi, Polymarket US, and Polymarket International separately. Polymarket US keys are Ed25519 credentials from its developer page. Its adapter supports balances, positions, and open orders; execution is intentionally unavailable. Kalshi read-only keys can sync a portfolio. A connection is activated only after a successful signed balance request. Credentials are encrypted at rest and never returned to the client; reconnecting replaces the saved credentials for that venue.

References: [Polymarket US API](https://docs.polymarket.us/), [Kalshi API](https://docs.kalshi.com/).

# Discovery

The homepage provides searchable prediction markets and category/league filters. Quotes and volume come from captured venue data; market details expose capture time. The existing sportsbook odds board remains at `/odds`. Logo source URLs are recorded in `public/assets/images/markets/sources.json`.
