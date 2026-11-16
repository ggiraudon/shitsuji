# Shitsuji today

A review of the code in `src/` (about 3,000 lines of TypeScript), written to decide what to keep, fix or replace.

## Summary

Shitsuji has a sound skeleton: an `Agent` loop, a pub/sub `MessageBus`, prompt pieces (`ContextInjectable`),
an LLM provider abstraction, a tool registry, a channel abstraction and file-based session storage. Many of
these pieces are not yet connected to each other, and a few have bugs that stop core flows from working
(conversation continuity, tool calls on Anthropic, webhook replies).

Good bones, early wiring. The [target architecture](02-target-architecture.md) keeps most of the concepts and
rewires them around a composition root and clear ports.

## Component inventory

| Area | Files | State | Keep? |
|------|-------|-------|-------|
| Agent loop | `core/Agent.ts` | Works for one provider. Loop: build context → call LLM → run tools → repeat. No iteration cap, no streaming, no cancellation. | **Keep the concept**, rebuild as `TurnRunner` ([F04](features/F04-agent-runtime.md)) |
| Message bus | `core/MessageBus.ts` | Simple synchronous pub/sub with topic union and a 100-message history. Global singleton. | **Keep**, make it an injected, typed `EventBus` instance |
| Plugin manager | `core/PluginManager.ts` | Interface and registry exist; nothing registers plugins. | **Keep**, make it the way channels, providers and tools are loaded ([F01](features/F01-core-architecture.md)) |
| Session | `core/Session.ts` | Holds messages and a key/value `memory` map; persists through `SessionStore`. `renderForContext()` is never called; nothing writes `memory`. | **Keep**, split into `Thread` / `Session` / `Turn` ([F04](features/F04-agent-runtime.md)) |
| LLM providers | `llm/*` | `BaseLLMProvider`, OpenAI and Anthropic over raw `fetch`. `baseUrl` is configurable, so DeepSeek already half-works through `OpenAIProvider`. | **Keep the abstraction**, rewrite adapters ([F03](features/F03-model-providers.md)) |
| Prompt context | `prompts/context/*` | `ContextInjectable` with conditions (`always`, `tool_used`, `pattern_detected`, `custom`, `once`) and priority ordering. Identity, tool list and rules injectables. | **Keep**, this is one of the best ideas in the codebase |
| Tools | `tools/*` | `BaseTool`, `ToolRegistry`, calculator, file read/write/list, shell, system info, web search. | **Keep the base class and registry**, add effects, validation, sandboxing ([F05](features/F05-tool-system.md)) |
| Channels | `channels/*` | `Channel` interface, `BaseChannel`, CLI and webhook channels, `ChannelManager` with a hard-coded `switch`. | **Keep the interface**, add a gateway and a richer message model ([F06](features/F06-channel-gateway.md)) |
| Memory | `memory/Memory.ts`, `SessionStore.ts` | `Memory` class is unused. `SessionStore` writes one JSON file per session. | Replace with repositories ([F02](features/F02-persistence.md)) and real memory ([F13](features/F13-long-term-memory.md)) |
| TUI | `tui/*` | Ink app with a One Dark theme. Re-implements the bootstrap that `index.ts` already does. | Keep as an optional client of the core, after [F01](features/F01-core-architecture.md) |
| Config | `utils/config.ts` | Zod schemas for global and agent config in `~/.shitsuji`. Mostly unused: provider choice is hard-coded from env variables. | Keep zod; centralise in the composition root |
| Logger | `utils/logger.ts` | Simple levelled logger. | Keep, add structured JSON output for containers |
| Tests | none | `vitest` is installed; no tests exist. | Add with each feature |

## Bugs and gaps found

These are concrete problems, not style notes. Each is fixed by the feature named in brackets.

1. ~~**No conversation continuity.**~~ *(fixed in S8: messages go to the owner's main chat session)* `index.ts` calls `agent.send(message.content)` without a session ID, and
   `Agent.send` creates a new session whenever no ID is given. Every CLI or webhook message starts a fresh
   conversation. [F04]
2. ~~**Tool calls break on Anthropic.**~~ *(fixed in S12: real tool_use / tool_result blocks, no history cut)* `AnthropicProvider` sends tool results as plain user text and never
   sends `tool_use` blocks back, so the model loses the link between a call and its result. It also cuts the
   history to the last 20 messages, which can split a call from its result. [F03]
3. ~~**OpenAI streaming tool calls fail.**~~ *(fixed in S11: ToolCallAccumulator assembles fragments)* `stream()` runs `JSON.parse` on each argument fragment, but the API
   sends arguments in pieces. Streaming also drops the tool-call mapping that `complete()` has. [F03]
4. ~~**No loop limit.**~~ *(fixed in S8: a step limit per turn; the repeated-failure check comes with F04)* `runLoop` has no maximum number of steps and no repeated-failure check, so a model that
   keeps calling tools never stops. [F04]
5. ~~**Webhook replies go nowhere.**~~ *(fixed in S30: the POST answers with the turn's reply, or 202 when
   it takes too long)* [F06]
6. ~~**The shell tool runs on the host, and its allowlist can be bypassed.**~~ *(contained in S17: no shell, confined to the workspace folder; fixed by F08)* The check is
   `cmd.startsWith('ls')`, so `ls; rm -rf ~` passes, and `node` / `npm` / `git` are allowed outright. [F05, F08]
7. ~~**File tools can read and write anywhere**~~ *(contained in S17: confined to the workspace folder; F08 moves them into the sandbox)* the process can (`resolve(path)` with no root). [F05, F08]
8. **Dead conditions.** The `once` condition is never true. `tool_used` checks `message.toolName`, which no
   assistant message sets. [F04]
9. ~~**Unused pieces.**~~ *(mostly fixed in S4–S8: PluginManager is now the loader; Memory, Session.memory and ConfigManager are gone)* `PluginManager`, `Memory`, `Session.memory`, `renderForContext()` and most of
   `ConfigManager` have no callers. [F01, F13]
10. ~~**Hidden global state.**~~ *(fixed in S4/S5: logger, event bus and config are injected)* `messageBus`, `configManager` and `logger` are module singletons, which makes
    testing and running several agents hard. [F01]
11. ~~**Web search depends on an unofficial third-party proxy**~~ *(fixed in S17–S18: replaced by a self-hosted SearXNG)* (`ddg-api.vercel.app`). [F05, F09]
12. **Out-of-date model names** (`claude-3-5-sonnet-20241022`, `gpt-4o`) are hard-coded as defaults. [F03]
13. ~~**Duplicate bootstrap.**~~ *(fixed in S6: both start from `createShitsuji()`)* `index.ts` and `tui/app.tsx` each build the agent and register tools. [F01]
14. ~~**The calculator tool always fails**~~ (found and fixed in S1). The function it generated started with
    `const E,LN10,… = this;`, a syntax error, so every expression failed, and its sanitizer stripped
    function names (`sqrt(16)` became `(16)`). It is now a small parser (`ExpressionEvaluator`) that never
    runs the input as JavaScript, covered by `test/tools/CalculatorTool.test.ts`.

## What Shitsuji is missing compared to the reference projects

Seen against the [inspiration survey](01-inspiration-survey.md), Shitsuji does not yet have:

- a sandbox, a browser, or a desktop of its own;
- durable work: tasks, schedules and background runs that survive restarts;
- long-term memory and skills;
- any policy or approval step before risky actions;
- a web UI, Telegram, or rich messages (buttons, cards, files);
- MCP or connected-app integrations;
- cost tracking, limits, or an activity log;
- tests and evaluations.

The [feature overview](03-feature-overview.md) orders these into phases.
