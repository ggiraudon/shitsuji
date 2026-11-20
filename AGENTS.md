# AGENTS.md

Rules for any coding agent (and human) working on **Shitsuji** (執事, "butler"): a proactive, self-evolving
personal assistant with its own sandboxed computer, deployed with Docker Compose.

## Read first

- `docs/README.md` is the index. **The docs are the spec**: build what the feature file says, and if the
  design has to change, change the doc in the same commit.
- `docs/11-fourth-pass-plan.md` is the current plan (steps S40–S49; passes `07`, `08` and `09` are done), and
  `docs/PROGRESS.md` is the checklist. The same steps are tracked as GitHub issues (see [Issues](#issues)).
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

## Issues

Work is tracked in GitHub issues on `ggiraudon/shitsuji`; the docs stay the spec.

- **Features** still to build are parent issues titled `F06: Channel gateway and Telegram`, linking to the
  feature file. **Plan steps** are their sub-issues, titled `S30: ChannelAdapter port and registry`. Open
  decisions get a `decision` issue linking to `docs/05-open-questions.md`, where the answer is recorded.
- **Bugs and ideas** found along the way get their own issue (labels `bug` or `idea`, plus the feature, such
  as `F11`), instead of being left in a chat or a summary. Each pass has a milestone (`Pass 3`).
- Name the issue in commits: `S30: Add the ChannelAdapter port (#12)`. The step's last commit closes it
  (`Closes #12` in the body).
- **For now, also tick `docs/PROGRESS.md`.** Not every agent can reach GitHub yet, so the checklist stays in
  sync with the issues until the owner says otherwise.
- If you can't reach GitHub, work from the plan and the feature files, and list the issues to open or close
  in your final report.

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

## The shared contract (submodule)

`packages/shared` is a **git submodule**: the [shitsuji-shared](https://github.com/ggiraudon/shitsuji-shared)
repo, default branch `master`. It holds the API's request, response and live-event shapes
(`@shitsuji/shared`), which core, the TUI and future clients (web UI, companion app) import.

- A fresh clone needs `git submodule update --init` (or `git clone --recurse-submodules`).
- After pulling master, run `git submodule update` so the submodule matches the commit core records.
- To change the contract: work inside `packages/shared` on its `master`, run `pnpm check` there, commit
  and push **that repo first**, then `git add packages/shared` in core and commit the new pointer together
  with the core code that needs it. Never commit a pointer to a submodule commit that is not pushed.
- `pnpm typecheck`, `pnpm test` and `pnpm --filter @shitsuji/core dev` build the shared package first;
  run `pnpm build:shared` yourself if anything else complains that `@shitsuji/shared` has no `dist`.

## Commands

Keep this list true as commands change.

| Command | What it does |
|---------|--------------|
| `pnpm install` | Install all workspace packages |
| `pnpm build` | Build every package |
| `pnpm build:shared` | Build the shared contract (`packages/shared`, a submodule) |
| `pnpm build:protocol` | Build the sandbox wire protocol (`packages/sandbox-protocol`); `@shitsuji/sandbox-daemon` needs its `dist` |
| `pnpm test` | Unit and contract tests (no network, no Docker) |
| `pnpm test:integration` | Tests against real Postgres, plus the sandbox conformance suite and egress probes against the real images (builds them if missing; needs Docker) |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm check` | Type-check, lint, import-direction check and tests: **run before every commit** |
| `pnpm eval --offline` | The evaluation scenarios against the recorded model replies (no key, no network) |
| `pnpm run docs` | Build the API docs and walkthroughs into `docs-site/` (git-ignored; `pnpm docs` is a pnpm command) |
| `pnpm eval --model <ref>` | The evaluation scenarios against a live model binding, with a report |
| `docker compose up` | Start the stack (`core`, `postgres`, `sandbox`, `egress-proxy`, `sandboxd-gateway`) |
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
  automatically. (A bounded wait for a cold sandbox's health check is not an outside action: `SandboxService`
  retries that at startup.)
- With `sandbox.driver: shitsuji` (the Compose default, X3), core never reads or writes `<dataDir>/workspace`
  itself: every file operation goes through `sandboxd`. `pnpm dev` from source keeps `host`.

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
