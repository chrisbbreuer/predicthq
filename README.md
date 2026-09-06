# PredictHQ

**Prediction Intel.** PredictHQ reads the public tape on Kalshi and Polymarket,
scores who keeps buying the side that wins, and turns that into positions — with
every automated decision backed by evidence drawn from our own data.

Built on [Stacks](https://stacksjs.com).

## What it does

**Signals.** Every few minutes the ingestion loop pulls the public trade tape and
market metadata from both venues. Polymarket fills are attributable to a proxy
wallet, so per-account win rates are real there; Kalshi's tape is anonymous, so
its signal is flow rather than identity. Both land in the same normalized shape.

**Odds board.** Sportsbook prices sit next to prediction-market implied
probabilities, so the best available price on each outcome — and any cross-book
arbitrage — is visible on one screen. Books are read directly rather than
through a paid aggregator, on a cadence set by how close each game is: seconds
for one in play, ten minutes for one next week. A paid feed remains configured
as a fallback for leagues our own adapters do not cover.

**Automated positions.** A strategy states what it will trade and how much. The
decision engine proposes, the evidence behind the proposal is recorded next to it,
and orders reach a venue only when a subscription entitles it. New strategies run
on paper first — the same decisions and the same limits, filled against the tape —
so a strategy has a track record before it has money behind it.

**A record of what happened.** Orders are reconciled against the venue every
minute, fills become positions, and positions settle against the market's own
result. That is what makes hit rate, realized return, and drawdown answerable,
and it is what the risk limits are computed from.

**Your book.** The same pass asks each connected account what it holds and what
is still resting, so `/positions` is the whole account rather than our half of
it — a position taken by hand in Kalshi's own app appears beside the ones a
strategy opened, marked to the current price.

## Requirements

- **Bun ≥ 1.3.14** — installed and pinned by [Pantry](https://github.com/home-lang/pantry) via `deps.yaml`
- **SQLite ≥ 3.47.2** for local development

## Getting started

```bash
./bootstrap
```

That installs Pantry, the machine dependencies, and the project's packages, then
generates an `APP_KEY`. Afterwards:

```bash
./buddy dev
```

The dev server serves the app at `https://predicthq.localhost` behind a reverse
proxy that issues a local certificate, with `http://localhost:3000` as a direct
fallback.

## Layout

| Path | What lives here |
| --- | --- |
| `app/Models/` | Bookmakers, markets, selections, odds, prediction markets, traders, trades |
| `app/Services/odds/` | The native feed: one adapter per book, the aggregator, the fallback, and the realtime engine |
| `app/Services/prediction-markets/` | Kalshi + Polymarket clients and smart-money analytics |
| `app/Actions/` | Query and command handlers, reused by routes, events, and the CLI |
| `app/Jobs/` | Scheduled ingestion and broadcast jobs |
| `app/Support/` | Pure domain logic — odds math, board assembly, branding |
| `app/Services/trading/` | Evidence, judgement, execution, reconciliation, positions |
| `routes/` | HTTP routes, registered through `app/Routes.ts` |
| `resources/views/` | stx templates for the board, live feed, smart money, and your book |
| `config/` | Typed configuration, one file per subsystem |

Framework internals live under `storage/framework/` and come from the published
`stacks` package. See [AGENTS.md](./AGENTS.md) for the conventions this project
follows and [DEPLOYMENT.md](./DEPLOYMENT.md) for shipping it.

## Commands

Start the dev server:

```bash
./buddy dev
```

Run the tests:

```bash
./buddy test
```

Lint and auto-fix:

```bash
./buddy lint:fix
```

Type check:

```bash
./buddy typecheck
```

Every Buddy command takes `--help`, and `./buddy --help` lists them all.

## What this is, and is not

PredictHQ is analysis tooling. It surfaces prices, order flow, and historical
accuracy, and it can place orders on venues you have connected with your own
credentials. It does not know what a position is worth to you, and nothing it
produces is financial advice.

## License

MIT — see [LICENSE.md](./LICENSE.md).
