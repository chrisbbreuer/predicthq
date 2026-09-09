# AGENTS.md

Guidance for AI coding agents (Claude Code, OpenAI Codex CLI, Cursor, and others)
working in this Stacks application. Every agent reads this file, so it is the one
place to record project-specific rules.

This is the starter version `buddy setup:ai` writes when a project has no
`AGENTS.md` yet. Edit it freely - it is yours, and it is committed so the whole
team (and every agent) sees the same rules.

---

## Project conventions

### Linting

- Use **pickier**, never eslint directly.
- Lint: `./buddy lint` Auto-fix: `./buddy lint:fix`
- For unused variables, prefer `// eslint-disable-next-line` over an underscore
  prefix.

### Frontend

- Use **stx** for templating. Never vanilla JS (`var`, `document.*`, `window.*`)
  inside stx templates - use signals (`state` / `derived` / `effect`) and
  composables.
- Use **Crosswind** utility classes for styling.
- Icons are Iconify classes (`i-{collection}-{name}`). Never hand-roll SVG paths
  and never add an icon npm package.
- Stacks ships no animation library. Use Crosswind transitions, CSS keyframes,
  scroll-driven animations, and the motion composables.

### Dependencies

- **buddy-bot** handles dependency updates, not renovatebot.
- **better-dx** supplies the shared dev tooling as peer dependencies. Do not
  install its peers (`typescript`, `pickier`, `bun-plugin-dtsx`) separately.
- `better-dx` requires `linker = "hoisted"` in `bunfig.toml`.
- The framework comes from the published `stacks` package, not a vendored
  `storage/framework/core`. `./buddy core:status` reports which layout is
  active; `./buddy publish:core --all` vendors it for framework development.

### Commits

- Conventional commit messages (`fix:`, `feat:`, `chore:`, ...).
- For requested implementation work, commit and push to `origin main` as the configured user. Never add coauthor trailers.

### Requirements

Bun >= 1.3.0, SQLite >= 3.47.2, TypeScript throughout.

---

## Repository map

| Path | What lives here |
|---|---|
| `app/` | Your code: `Actions/`, `Jobs/`, `Listeners/`, `Middleware/`, `Mail/`, `Commands/`, `Models/`, `Skills/`, plus `Routes.ts`, `Events.ts`, `Gates.ts`, `Scheduler.ts` |
| `routes/` | Route files, registered via `app/Routes.ts` |
| `config/` | Typed configuration, one file per subsystem |
| `database/` | Migrations, seeders, local SQLite files |
| `resources/` | stx frontend: `views/`, `components/`, `layouts/`, `partials/` |
| `storage/framework/` | Framework internals and defaults. Read-only reference |
| `tests/` | Bun test suites |

### The `app/` override model

Stacks resolves files from `app/` first and falls back to
`storage/framework/defaults/app/`. To customize a framework default, create the
same path under `app/` and it wins.

---

## Skills

The framework ships a skill per subsystem under
`storage/framework/defaults/ai/skills`, each documenting that area
authoritatively. Read the relevant `SKILL.md` before doing non-trivial work
rather than guessing at an API.

Add your own with `app/Skills/<name>/SKILL.md`, then re-run `buddy setup:ai`.

---

## Before finishing

- Lint: `./buddy lint` (fix with `./buddy lint:fix`)
- Type check: `./buddy typecheck`
- Test: `./buddy test`


## Production deployment

Pushing to `main` automatically deploys production through the `CI` workflow.
Inspect and wait for its `deploy-prod` job, then verify the live site. Do not also
run `buddy deploy` for the same commit: replacing the live release directory can
interrupt the serving process. Manual deployment is a recovery path only after
confirming there is no pending or running production deployment in GitHub.
