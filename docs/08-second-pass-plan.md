# Second pass plan: F05 + F04 + HTTP API and TUI

The second pass finishes Phase 0 and gives Shitsuji its first real interface:

- [F05](features/F05-tool-system.md): tools v2. Every tool has a schema, an effect and a target, and every
  call goes through one pipeline.
- [F04](features/F04-agent-runtime.md): the agent runtime. Queued turns, streaming, Stop, steering, step
  limits, compaction and standing instructions.
- **The HTTP API, with the TUI as its client** (decision A5). It's the first interface, used for
  troubleshooting before the web UI ([F07](features/F07-web-ui.md)) exists.

F05 comes first because F04's turn runner sends every tool call through F05's pipeline. As in the first
pass, each step is a few small commits, every commit passes `pnpm check`, and [PROGRESS.md](PROGRESS.md) is
ticked in the commit that completes a step.

**Done when** you can open the TUI on your PC and do all of this:
- chat with Shitsuji and watch the reply stream in, along with each tool it runs;
- press Esc to stop a long turn, and get control back within a second;
- send a second message while it's working and have it answered in the same turn.

The same conversation also continues through the webhook and survives a restart of `core`.

**Not in this pass:**
- Telegram and the full channel gateway ([F06](features/F06-channel-gateway.md)). The webhook stays as it
  is, including bug 5, where replies are only printed to the logs.
- The web UI ([F07](features/F07-web-ui.md)).
- The trust service and approvals ([F11](features/F11-trust-and-approvals.md)). Until F11, tools that act
  outside are refused, as described in S16.
- The sandbox container ([F08](features/F08-workspace-sandbox.md)). Decision Q1 below covers what the host
  file and shell tools may do until then.

## Decisions needed before starting

All five were decided on 2026-11-15 and are recorded in
[05-open-questions.md](05-open-questions.md#second-pass-decided-2026-11-15). Q1 differs from the proposal: the
shell tool is on by default.

| # | Question | Proposal |
|---|----------|----------|
| Q1 | Until the sandbox exists (F08), what may the file and shell tools do on the machine running `core`? Today they can read and write anywhere, and the shell allowlist can be bypassed (bugs 6 and 7). | **Decided:** file tools only inside `<dataDir>/workspace`; the shell tool **on by default**, inside that folder, without a shell interpreter, and can be turned off in the config |
| Q2 | Web search uses an unofficial third-party proxy (bug 11). | A `SearchProvider` port with a **SearXNG** container in Compose as the default, plus `web.fetch` for readable page text. The proxy is removed |
| Q3 | How does the TUI prove it's you? | An owner key, created at first start and stored hashed. The TUI sends it as a Bearer token; the web UI will swap it for a cookie later (F07) |
| Q4 | Keep the CLI channel (stdin/stdout) once the TUI works? | Remove it. The TUI replaces it, and the server no longer reads stdin |
| Q5 | Step limits per session kind | `chat` 40, `task` 200, `helper` 30, `schedule` 40, `observer` 20, configurable in `runtime.limits` |

## Target additions

```
packages/
├── shared/src/                  API request/response and live-event types (zod), shared with the TUI and web
└── core/src/
    ├── ports/        Tool (v2), SearchProvider, SoulStore
    ├── application/  tools/ (pipeline, middlewares, ToolCatalog, tool_search)
    │                 runtime/ (ThreadService, MessageIntake, TurnScheduler, TurnRunner, ContextBuilder,
    │                           Compactor, SteeringInbox, StopController, StallDetector, ReplyRouter)
    ├── adapters/     tools/ (math, files, exec, web, system), search/ (searxng)
    ├── interfaces/   http/ (Hono REST + WebSocket), tui/ (Ink client of the API)
    └── plugins/      core-tools updated, web-search
```

## Steps

### Tools v2 (F05)

#### S15. Tool v2 port and schemas
- Add `BaseTool` with a zod `input` schema, an `effect` (`read`, `compute`, `write_local`, `write_self`,
  `external`, `payment`, possibly depending on the arguments), a `target`, `deferred` and `untrustedOutput`.
- Add `ToolContext` (turn, session, `AbortSignal`, `TurnLock`, logger, events) and typed `ToolOutcome`s.
- Convert zod schemas to JSON Schema for the models (`zod-to-json-schema`).
- Map dotted names such as `math.evaluate` to `math__evaluate` in the model adapters.
- *Check:* unit tests for schema conversion and name mapping; recorded DeepSeek fixtures still pass.

#### S16. The execution pipeline
- One class per middleware, built in the composition root, in this order:
  1. Cancellation
  2. Validation (field-level errors, no side effect)
  3. RepeatFailure (5 identical failures end the turn)
  4. Trust
  5. Receipt (`tool_start` / `tool_end` in `turn_events`)
  6. Execute
  7. OutputLimit (head and tail kept)
  8. Redaction (a pass-through until F12)
  9. UntrustedWrap (`<untrusted_data>`)
- Until F11, the trust middleware is a fixed policy: `read`, `compute`, `write_local` and `write_self` are
  allowed; `external` and `payment` are **refused** with "needs approvals (F11)".
- *Check:* a test per middleware, and a test that a call with invalid arguments has no side effect. F05
  criteria 2 and 3.

#### S17. Built-in tools on v2
- `math.evaluate` replaces the calculator.
- `system.status` reports Shitsuji's own health (database, job queue, model) instead of the host's.
- `workspace.read`, `workspace.write` and `workspace.list` are confined to `<dataDir>/workspace`, with path
  traversal and symlink escapes refused (Q1).
- `workspace.exec` is on by default and can be turned off in config. It runs one program with arguments
  (no shell), with its working folder inside the workspace, a timeout and an output cap (Q1).
- Remove the old `Tool` interface and `ToolRegistry`.
- *Check:* tests for the confinement, including `../` and symlinks. F05 criterion 1. Bugs 6 and 7 are
  contained, not fixed: F08 fixes them.

#### S18. Web search and fetch
- Add a `SearchProvider` port with a SearXNG adapter, a `searxng` service in Compose (internal network, no
  published port), `web.search`, and `web.fetch` (readable text, a size limit, `untrustedOutput`).
- Remove the unofficial proxy (bug 11) (Q2).
- *Check:* adapter tests from recorded SearXNG JSON; a live search through Compose.

#### S19. Deferred discovery
- Add `ToolCatalog` with a core set plus deferred tools, a `tool_search` tool (the top 3 strong matches
  return their schemas), and `ToolIndexInjectable` listing the deferred names.
- Found tools are called through the `tool_call` gateway, which the pipeline unwraps, so the tools array
  stays the same for the whole session and the prompt cache stays valid. (Changed after S19 shipped:
  the first version added each found tool to the array, costing a cache miss per discovery.)
- *Check:* with 40 deferred test tools, the first request carries only the core set and the index (F05
  criterion 4), and the tools array is identical on every request of a session.

### Runtime (F04)

#### S20. Message intake and the turn scheduler
- `ThreadService` finds the owner's thread.
- `MessageIntake` stores the owner's message and either enqueues a turn with a `session.drain` job, in the
  same transaction, or, if a turn is already running in that session, hands the message to it (steering).
- `TurnScheduler` handles `session.drain`: it starts the oldest queued turn of a session with none running,
  through the compare-and-set update.
- `send()` returns a turn ID immediately. A `ReplyRouter` delivers the final reply to the channel the
  message came from, so the webhook and CLI keep working.
- *Check:* integration tests on Postgres: two messages give one running turn and one queued; sessions run
  in parallel.

#### S21. TurnRunner with streaming
- Replace `Agent.runLoop` with `TurnRunner`. It streams the model and publishes `turn.status`,
  `turn.text_delta` and `tool.started` / `tool.finished` events, and runs tools through the pipeline.
- Step limits per session kind (Q5).
- `StallDetector`: two continuations with no successful tool call, or the same error three times.
- A failed model request keeps your message and records the cause.
- *Check:* tests for streaming order, the step limit with a clear reason (F04 criterion 4), and stall
  detection.

#### S22. Stop and steering
- `StopController` holds an `AbortController` per running turn. Stop aborts the model stream and any pending
  tool, marks the turn `cancelled`, and **withdraws** the request.
- The `SteeringInbox` is drained before each model call. A message that arrives just as a turn finishes
  starts a new turn instead of being lost.
- *Check:* Stop during a tool that never resolves returns within one second (F04 criterion 3, F05
  criterion 3); a message sent mid-turn is answered in that turn (F04 criterion 2).

#### S23. ContextBuilder, standing instructions and compaction
Design: [F04 context building](features/F04-agent-runtime.md#context-building) (decisions Q6 and Q7).
- **Placement and order.** Injectables declare `placement` (`header`, `context` or `tail`) and an
  ascending `order`, replacing `priority`. The three existing injectables are migrated. `ContextBuilder`
  replaces the runner's context code: it builds the system prompt from the header, inserts context notes
  into the history, and attaches the tail to the newest message for that call only.
- **SOUL, assembled.** Soul fragments and revisions in a new migration, and `SoulInjectable` (header, 0)
  rendering the current revision. Each turn records the revision it used. `SOUL.md` is written as a
  readable export, and editing it creates a revision once confirmed (in the TUI, for now). Changes take
  effect at the next turn. Proposals by Shitsuji wait for F11.
- **Your profile and the clock.** `OwnerProfileInjectable` (header) holds your name, time zone and
  locale; `ClockInjectable` (tail) the local time.
- **Conditions.** `once` is tracked per session, and a new `session_kind` condition is added.
- **Header stability check.** A warning in development and tests when a header injectable changes on
  every call.
- **Compaction.** `Compactor` summarises older messages with the `summarize` model when the history nears
  the model's context window; `CompactionSummaryInjectable` (context, 0) puts the summary at the start of
  the history. The full transcript stays stored.
- *Check:*
  - compaction keeps the open request (F04 criterion 5);
  - tests cover the layout and order of a request across all three placements;
  - a request carries the clock in the tail and not in the system prompt;
  - a SOUL revision takes effect at the next turn, not in the middle of one.

### Interface

#### S24. HTTP API
- Hono on `@hono/node-server`, bound to 127.0.0.1 by default.
- REST routes:
  - `POST /api/messages`
  - `GET /api/sessions/:id/messages`
  - `GET /api/turns/:id`
  - `POST /api/turns/:id/stop`
  - `GET /api/usage`
  - `GET /api/health`
- One WebSocket, `/api/events`, carrying filtered, redacted live events.
- Request, response and event types live in `packages/shared` as zod schemas.
- Owner key auth (Q3).
- *Check:* route tests through `app.request()`, a WebSocket test, and every route refusing a missing or
  wrong key.

#### S25. The TUI as an API client
- Rewrite the Ink TUI against the API: history on start, a streaming reply, tool activity lines, Esc to
  stop, and `/new` for a new session.
- `shitsuji tui` connects to `SHITSUJI_API_URL`, which defaults to localhost, with the owner key.
- Remove the CLI channel (Q4).
- *Check:* tests that render the TUI against a fake API; a manual run against the real one.

#### S26. End to end and docs
- Live check on DeepSeek through Compose, using the TUI on the host against the containerised `core`:
  - stream a reply;
  - stop a turn;
  - steer a turn with a second message;
  - restart and continue the conversation.
- Record new fixtures where the formats changed.
- Update the README, AGENTS.md and the class map.
- *Check:* every F04 and F05 criterion that this pass can meet is ticked. F04 criterion 1 (Telegram) waits
  for F06; the webhook and the TUI landing in one thread is tested instead.

## Things you'll need to provide

| When | What |
|------|------|
| S18 | Nothing: SearXNG runs locally with no key |
| S26 | About ten minutes to try the TUI yourself |
