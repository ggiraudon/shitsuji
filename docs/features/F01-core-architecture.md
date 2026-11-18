# F01 — Core architecture and composition root

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 0 Foundations | 1 | M | — | everything |

## What it is

A reorganisation of `src/` into the layers described in [02-target-architecture.md](../02-target-architecture.md):
domain, ports, application, adapters, interfaces, plugins and one composition root. No new user-facing
behaviour, but every later feature is built on it.

## Inspiration

- **nod:** `src/ports` (capabilities as interfaces), `src/providers` (vendor code), and one `composition.ts`
  that selects every implementation. A script fails the build when an import crosses a boundary, and only the
  composition root reads `process.env`.
- **openbot:** services built with explicit dependency layers and typed errors; tests through injected
  boundaries.

## Design

### Composition root

```ts
// composition/createShitsuji.ts
export async function createShitsuji(config: ShitsujiConfig): Promise<Shitsuji> {
  const clock = new SystemClock();
  const log = new JsonLogger(config.logging);
  const events = new InProcessEventBus(log);

  const db = await PostgresDatabase.connect(config.database);           // F02
  const repos = new PostgresRepositories(db);
  const jobs = new PgBossJobQueue(db, log);

  const plugins = new PluginManager({ log, events, config });
  await plugins.loadBuiltIns([openAiCompatiblePlugin, anthropicPlugin,
                              telegramPlugin, webPlugin, workspacePlugin, desktopPlugin]);
  await plugins.loadFromDirectory(config.plugins.directory);

  const models = new ModelRouter(plugins.providers(), config.models);   // F03
  const tools = new ToolRegistry(plugins.tools());                      // F05
  const runtime = new TurnRunner({ repos, models, tools, events, clock, log }); // F04
  const gateway = new ChannelGateway(plugins.channels(), repos, jobs, events);  // F06

  return new Shitsuji({ runtime, gateway, jobs, events, db, plugins, log });
}
```

`Shitsuji` is a small facade with `start()` and `stop()` that starts the job workers, channel adapters and the
HTTP server, and shuts them down in reverse order.

### Configuration

One zod schema, `ShitsujiConfig`, loaded from `shitsuji.config.yaml` plus environment variables (so Compose can
pass secrets). Only `composition/loadConfig.ts` reads files or `process.env`. Secrets in config are typed as
`Secret` (a wrapper with no `toString`) so they do not leak into logs.

### Event bus

Today's `MessageBus` becomes the `EventBus` port with an `InProcessEventBus` adapter:

```ts
export interface EventBus {
  publish<K extends keyof ShitsujiEvents>(type: K, payload: ShitsujiEvents[K], meta?: EventMeta): void;
  subscribe<K extends keyof ShitsujiEvents>(type: K, handler: Handler<ShitsujiEvents[K]>): Unsubscribe;
  subscribePattern(pattern: `${string}.*`, handler: Handler<unknown>): Unsubscribe;
}
```

- `ShitsujiEvents` is a typed map (`'turn.started': { turnId, sessionId }`, …), so payloads are checked at
  compile time. Today's topics are a string union with `unknown` payloads.
- Handlers may be async; errors are caught and published as `system.error`, as today.
- The bus is for **notification** (UI updates, metrics, proactivity signals). Anything that must survive a
  crash is written to the database first ([F02](F02-persistence.md)), then published.

### Plugins

Today's `PluginManager` becomes the loader for everything pluggable:

```ts
export interface ShitsujiPlugin {
  readonly manifest: PluginManifest;   // id, name, version, provides: ('channel'|'model'|'tools'|'computer')[]
  register(ctx: PluginRegistrationContext): Promise<void>;
  dispose?(): Promise<void>;
}

export interface PluginRegistrationContext {
  config: PluginConfigView;            // only this plugin's section
  log: Logger;
  events: EventBus;
  addModelProvider(p: ModelProvider): void;
  addChannel(c: ChannelAdapter): void;
  addTools(t: Tool[]): void;
  addComputer(c: ComputerBackend): void;
  addContextInjectable(i: ContextInjectable): void;
}
```

The registration context is the only way a plugin reaches the core, which keeps plugins from importing
internals. Self-authored tools ([F20](F20-tool-forge.md)) use a stricter, sandboxed variant.

### Errors

A small `ShitsujiError` hierarchy with a `code` and safe `details` (`ProviderError`, `ToolInputError`,
`PolicyDenied`, `SandboxUnavailable`, …). Error messages keep the specific cause, never a generic "something
went wrong", and are redacted before they are stored or shown.

## Changes to existing code

| File | Change |
|------|--------|
| `core/MessageBus.ts` | → `ports/EventBus.ts` + `adapters/events/InProcessEventBus.ts`; remove the exported singleton |
| `core/PluginManager.ts` | Extend as above; becomes the only loader |
| `utils/config.ts` | → `composition/loadConfig.ts` with one schema |
| `utils/logger.ts` | → `Logger` port + `JsonLogger` (structured, for containers) and `PrettyLogger` (CLI) |
| `index.ts`, `tui/app.tsx` | Both call `createShitsuji()`; the duplicate bootstrap goes |
| `channels/index.ts` | The hard-coded `switch` in `ChannelManager` goes; channels come from plugins |

## Acceptance criteria

- `createShitsuji()` is the only place that constructs adapters; `grep process.env src` matches only
  `composition/`.
- An import-direction check runs in CI and fails on a violation.
- The CLI and TUI start from the same composition root.
- Vitest runs; at least the event bus, plugin manager and config loader have unit tests.

## Risks and open questions

- The refactor touches every file. Do it in one focused pass before features land, or the two will conflict.
- **Decided (A1):** a pnpm monorepo from the start, beginning with `packages/core` and
  `packages/shared`. `packages/web`, `packages/workspace-daemon` and `packages/desktop-daemon` are added when
  [F07](F07-web-ui.md), [F08](F08-workspace-sandbox.md) and [F10](F10-desktop.md) start. The layers above
  live in `packages/core/src`. See [07-first-pass-plan.md](../07-first-pass-plan.md).
  *(2026-11-17: `packages/shared` became a git submodule, the `shitsuji-shared` repo, so the companion
  app can share the API contract; the API types moved there from `interfaces/http/contract.ts`.)*
