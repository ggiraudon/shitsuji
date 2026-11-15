# AGENTS.md

Rules for any coding agent (and human) working on **Shitsuji** (執事, "butler"): a proactive, self-evolving
personal assistant with its own sandboxed computer, deployed with Docker Compose.

## Read first

- `docs/README.md` is the index. **The docs are the spec**: build what the feature file says, and if the
  design has to change, change the doc in the same commit.
- `docs/08-second-pass-plan.md` is the current plan (steps S15–S26; the first pass, `07`, is done), and
  `docs/PROGRESS.md` is the checklist.
- `docs/05-open-questions.md` holds the decisions. Don't reopen a decided one without asking. If an open one
  blocks you, ask.
- `docs/06-class-map.md` gives the intended class structure.

## Commits: small and very frequent

- **Commit after every small working change.** One concern per commit: a moved folder, one port plus its
  adapter, one test. If a commit message needs "and", it is probably two commits.
- Every commit builds, lints and passes its tests. Don't commit a broken tree "to fix in the next commit".
- Tick the matching boxes in `docs/PROGRESS.md` **in the commit that makes them true**, and name the step
  (`S4: …`) or feature (`F03: …`) at the start of the subject line.
- Use `git mv` when moving files, so their history follows them.
- Commit messages: an imperative subject of 72 characters at most, a blank line, then *why* if it isn't
  obvious.
- **Never push, force-push, rewrite published history or change remotes unless the owner asks.**
- Never commit `.env`, keys, tokens, real email addresses or database dumps.

## Environment

- Development is on **Windows**, in this repo folder. Node 22, pnpm (pinned in `packageManager`), and Docker
  Desktop with the WSL2 backend.
- Shells: Git Bash or PowerShell. Scripts in `package.json` must work in both, so use Node scripts rather than
  shell one-liners. On this machine `bash` on `PATH` may be WSL rather than Git Bash: run the shell scripts
  with `C:\Program Files\Git\bin\bash.exe`, and add `C:\Program Files\Docker\Docker\resources\bin` to `PATH`
  for `docker`.
- Line endings are **LF** (enforced by `.gitattributes`).
- Docker Desktop mounts Windows folders slowly and file watching across them is unreliable. So dev containers
  keep `node_modules` and database data in named volumes and run watchers inside the container.
- Compose files must run unchanged on a plain Linux host: no Windows paths, no `host.docker.internal`, and no
  other Docker Desktop-only features.

## Commands

Keep this list true as commands change.

| Command | What it does |
|---------|--------------|
| `pnpm install` | Install all workspace packages |
| `pnpm build` | Build every package |
| `pnpm test` | Unit and contract tests (no network, no Docker) |
| `pnpm test:integration` | Tests against real Postgres via Testcontainers (needs Docker) |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm check` | Type-check, lint, import-direction check and tests: **run before every commit** |
| `docker compose up` | Start the stack (`core` + `postgres`) |
| `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres` | Only Postgres, published on 127.0.0.1:5432, for running core on the host |
| `pnpm --filter @shitsuji/core dev` | Run core from source with reload (reads `.env` and `shitsuji.config.yaml`) |
| `node packages/core/dist/cli.js tui` | The terminal UI, after `pnpm build` |

Commands that pipe output (`pnpm check | grep …`) hide failures: use `set -o pipefail` before
committing on the result.


## Architecture rules

- Layers live in `packages/core/src`: `domain`, `ports`, `application`, `adapters`, `interfaces`, `plugins`,
  `composition`. The import rules in `docs/02-target-architecture.md#layers` are enforced by
  `scripts/check-imports.ts`. Don't weaken the check to make code pass.
- **Only `composition/` reads `process.env` or config files, and only `createShitsuji()` constructs
  adapters.** Everything else receives its dependencies through the constructor. No singletons, and no
  module-level state.
- External systems sit behind a port (an interface in `ports/`) with an adapter in `adapters/`. Vendor types
  never leak past the adapter.
- Validate every input from outside (config, HTTP, model tool calls, channel messages) with zod.
- Secrets use the `Secret` type, and must never be logged, put in error messages, sent to a model, or passed
  into the workspace or desktop containers.
- Errors are `ShitsujiError` subclasses with a `code` and the specific cause, never "something went wrong".
- Database: Kysely, with plain-SQL migrations that are **forward-only**: never edit a migration once it is
  committed; add a new one. State changes use compare-and-set (`UPDATE … WHERE status = $from`).
- Model calls go through `ModelRouter` by purpose, never to a hard-coded model.
- Never retry a model request after a tool call has been emitted, and never retry an outside action
  automatically.

## Tests

- Vitest. Every new class with logic gets unit tests in the same commit.
- Unit tests use the in-memory adapters, and make no network or Docker calls.
- Model adapters are tested against recorded HTTP fixtures. **No live model calls in tests.**
- Postgres adapters are tested against real Postgres (Testcontainers), not mocks.
- When fixing a bug, first add a test that fails because of it.

## Borrowing ideas

`../inspiration/` holds nod, openbot, openfuse and OpenMausBot for **ideas only**. Never copy code, text or
assets from them, even small snippets. openbot is PolyForm Noncommercial. Write our own implementation.

## Self-modification

The agent may eventually change its own tools and code (F19–F21). Any code path that lets Shitsuji change
its own source, prompts or permissions must follow `docs/04-self-evolution.md`: proposals, tests, review by
the owner and a rollback path. Never a direct write to the running code.
