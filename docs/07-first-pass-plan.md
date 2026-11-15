# First pass plan: F01 + F02 + F03

The first pass rebuilds the foundations in one go, as decided in
[05-open-questions.md](05-open-questions.md#decided-2026-11-14) (R1):

- [F01](features/F01-core-architecture.md): the structure, with layers, ports, plugins and one composition root.
- [F02](features/F02-persistence.md): the database, Postgres with Kysely and pg-boss.
- [F03](features/F03-model-providers.md): model providers and the router.

The steps below are in order. Each one is a few small commits. Every commit builds and passes its tests, and
the checklist in [PROGRESS.md](PROGRESS.md) is ticked in the commit that completes a step.

**Done when:** you can chat with Shitsuji from the CLI or the TUI on DeepSeek V4.1 Flash, with tool calls
working. Every message and turn is stored in Postgres and survives a restart of `core`, and the whole stack
starts with `docker compose up`.

**Not in this pass:**
- The full turn runtime with sessions, parallel turns and Stop ([F04](features/F04-agent-runtime.md)), and
  the new tool pipeline ([F05](features/F05-tool-system.md)).
- The HTTP API and the TUI rebuilt as its client. These come first in pass 2, so the TUI is the first working
  interface (A5).
- Telegram ([F06](features/F06-channel-gateway.md)) and the web UI ([F07](features/F07-web-ui.md)).

Today's `Agent` loop and tools keep working through the pass, moved onto the new ports.

## Target layout at the end of the pass

```
seahorse/                     (folder to be renamed shitsuji later)
├── AGENTS.md  CLAUDE.md
├── package.json              workspace root: scripts only
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js  .prettierrc  .gitattributes  .editorconfig
├── compose.yaml              core + postgres
├── compose.dev.yaml          dev overrides (watch mode, ports on 127.0.0.1)
├── shitsuji.config.example.yaml
├── scripts/check-imports.ts
├── docs/
└── packages/
    ├── shared/               types shared with the web UI and daemons later (IDs, event payloads, DTOs)
    └── core/
        ├── Dockerfile
        ├── migrations/       plain SQL, forward-only
        ├── src/
        │   ├── domain/       Thread, Session, Turn, Message, ToolCall, Money, IDs, errors
        │   ├── ports/        EventBus, Logger, Clock, ModelProvider, *Repository, UnitOfWork, JobQueue, ChannelAdapter, Tool
        │   ├── application/  Agent (today's loop, moved), ModelRouter, ContextBuilder + injectables
        │   ├── adapters/     events/, logging/, postgres/, jobs/, models/, channels/, tools/
        │   ├── interfaces/   cli/, tui/
        │   ├── plugins/      built-in plugins: openai-compatible, anthropic, cli-channel, core-tools
        │   └── composition/  loadConfig, createShitsuji, Shitsuji facade
        └── test/             unit, integration (Testcontainers), contract (HTTP fixtures)
```

`web`, `workspace-daemon` and `desktop-daemon` are added when their features start. We don't create empty
packages.

## Steps

### S1. Tooling baseline
- Add `.gitattributes` (`* text=auto eol=lf`), so the line endings stay LF on Windows, and `.editorconfig`.
- Add an ESLint flat config and Prettier. Lint is broken today because there is no config.
- Make `vitest run` pass with a first trivial test.
- *Check:* `npm run build`, `npm run lint` and `npm test` all succeed.

### S2. pnpm monorepo
- Add `pnpm-workspace.yaml` and `tsconfig.base.json`, and move the code into `packages/core` with `git mv`
  so its history is kept. Add an empty `packages/shared`.
- Replace `package-lock.json` with `pnpm-lock.yaml`, and pin pnpm in `packageManager`.
- *Check:* `pnpm install`, `pnpm -r build` and `pnpm -r test` pass, and the CLI still starts.

### S3. Layer folders and the import check
- Create the seven layer folders and move files to where they belong, without changing behaviour yet.
- Write `scripts/check-imports.ts` with the rules from
  [02-target-architecture.md](02-target-architecture.md#layers) and add it to `pnpm check`.
- *Check:* `pnpm check` passes, and a deliberately bad import makes it fail (tested).

### S4. Core ports: logger, clock, event bus, errors
- Add the `Logger` port with `JsonLogger` and `PrettyLogger`, and the `Clock` port with `SystemClock`.
- Turn `MessageBus` into an `EventBus` port plus `InProcessEventBus`, with the typed `ShitsujiEvents` map
  and no singleton.
- Add the `ShitsujiError` hierarchy.
- *Check:* unit tests for the event bus, including that async handler errors become `system.error`.

### S5. Configuration
- Write `composition/loadConfig.ts`: one zod `ShitsujiConfig` read from `shitsuji.config.yaml` plus
  environment variables, with a `Secret` type that can't be printed.
- *Check:* unit tests for the loader (defaults, environment overrides, invalid config, secrets masked in
  logs), and `grep process.env` matches only `composition/`.

### S6. Plugins and the composition root
- Turn `PluginManager` into the only loader, using `ShitsujiPlugin` and `PluginRegistrationContext`.
- Wrap today's providers, channels and tools as built-in plugins, and remove the hard-coded `switch` in
  `ChannelManager`.
- Add `createShitsuji()` and the `Shitsuji` facade with `start()` and `stop()`, called by both the CLI
  and the TUI.
- *Check:* plugin manager unit tests pass, the CLI and TUI both start from `createShitsuji()`, and F01's
  acceptance criteria are all ticked.

### S7. Domain model
- Add the `Thread`, `Session`, `Turn` (as a state machine), `Message` with content parts, `ToolCall`, branded
  IDs and `Money`.
- Split today's `Session` into these classes.
- *Check:* unit tests for turn transitions, where illegal transitions throw.

### S8. Persistence ports and in-memory adapters
- Add `UnitOfWork`, the `Thread`, `Session`, `Turn`, `Message` and `TurnEvent` repositories, and
  `JobQueue`, with `InMemory*` implementations for tests.
- Point the agent at the repositories instead of `SessionStore`.
- *Check:* application tests run entirely in memory.

### S9. Postgres adapters
- Add `compose.yaml` with `postgres` (pgvector image, `internal` network, named volume), and
  `compose.dev.yaml` that publishes 5432 on `127.0.0.1`.
- Write the Kysely migrator and the first migration (owners, threads, sessions, turns, messages, turn_events,
  channel_bindings). Generate the types from it.
- Write the `Postgres*` repositories, with `transition()` as a compare-and-set, and `TurnLock`.
- *Check:* repository tests against real Postgres via Testcontainers, and a concurrency test proving only one
  worker starts a turn.

### S10. Job queue and startup recovery
- Add `PgBossJobQueue`, with enqueueing that can join a transaction.
- At startup, turns left `running` become `failed(interrupted)`.
- Remove `SessionStore` and `Memory.ts`.
- *Check:* the crash test (kill the process mid-turn, restart, the turn is `failed(interrupted)` and the
  session continues) and F02's acceptance criteria are ticked.

### S11. Model provider port and the OpenAI-compatible adapter
- Add the `ModelProvider` port (streaming only, with `complete()` as a helper) and message content parts.
- Write `OpenAICompatibleProvider` with `ProviderQuirks`, `ToolCallAccumulator` and `TextToolCallParser`.
- *Check:* contract tests from recorded HTTP fixtures (DeepSeek, Ollama), including streaming tool calls with
  fragmented arguments. No live calls.

### S12. Anthropic adapter
- Rewrite it with proper `tool_use` and `tool_result` blocks and the system prompt sent separately. Remove
  the 20-message cut.
- *Check:* contract tests from fixtures.

### S13. Catalogue, router and decorators
- Add `ModelInfo`, `ModelRouter` (purposes, needs, fallbacks), `RetryingModelProvider` and
  `MeteredModelProvider`. The usage table is a stub until F22. `RedactingModelProvider` passes through
  unchanged until F12.
- Remove the provider selection in `index.ts`.
- *Check:* router unit tests, and switching a purpose's model is a configuration change only.

### S14. Container and end-to-end
- Add the `packages/core/Dockerfile` (multi-stage, non-root user) and a `core` service in `compose.yaml`
  with migrations at startup and `node_modules` in the image, not mounted from Windows.
- Run a live smoke test by hand: chat on DeepSeek V4.1 Flash with a tool call, restart `core`, and check the
  history is still there.
- *Check:* `docker compose up` creates the schema and the "done when" above holds. Every criterion in F01,
  F02 and F03 is ticked in PROGRESS.md.

## Things you'll need to provide

| When | What |
|------|------|
| S11 (fixtures can be recorded later) and S14 | `DEEPSEEK_API_KEY` in `.env` (never committed) |
| S12 (optional) | An Anthropic key, only to record fixtures; otherwise the fixtures are written by hand from the API docs |
| S14 | A restart of the Claude app, so `docker` is on this session's PATH |
