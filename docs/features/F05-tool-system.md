# F05 — Tool system v2

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 0 Foundations | 4 | M | F01 | F04, F08, F09, F10, F11, F14, F18, F20 |

## What it is

Tools that say what they do and where they run, a middleware pipeline that every call passes through, and
deferred discovery so the prompt carries only the tools a task needs.

## Where Shitsuji is today

`Tool` has `name`, `description`, a JSON `schema` and `execute(params)`. `ToolRegistry` holds tools and runs
them. There is no input validation, no notion of risk, and every tool runs in the `core` process on the host.

## Inspiration

- **nod:** every tool call passes one turn guard; results from outside reach the model wrapped as untrusted
  data; five repeated failures of the same tool end the run; rejected calls name the missing or invalid fields.
- **openbot:** a few direct tools plus `tool_search` / `tool_describe` / `tool_call`; strong matches return
  their schema at once to save a model step; a context-budget check fails CI when tool definitions grow.
- **OpenMausBot:** per-agent tool allow / exclude lists for small local models.

## Design

### Tool definition

```ts
export type ToolEffect =
  | 'read'          // reads state, changes nothing (search, read file)
  | 'compute'       // pure computation (calculator)
  | 'write_local'   // changes the agent's own workspace or desktop
  | 'write_self'    // changes Shitsuji's own state (memory, schedules, settings)
  | 'external'      // acts on the outside world (send email, post, submit form)
  | 'payment';      // spends money

export type ToolTarget = 'core' | 'workspace' | 'desktop' | 'mcp';

export abstract class BaseTool<I extends z.ZodTypeAny, O = unknown> {
  abstract readonly name: string;                // "workspace.exec", "browser.click"
  abstract readonly description: string;         // the call contract, short
  abstract readonly input: I;                    // zod schema → JSON Schema for the model
  abstract readonly effect: ToolEffect | ((args: z.infer<I>) => ToolEffect);
  readonly target: ToolTarget = 'core';
  readonly deferred: boolean = false;            // hidden until discovered
  readonly untrustedOutput: boolean = false;     // true for web, email, browser, MCP results
  protected abstract run(args: z.infer<I>, ctx: ToolContext): Promise<ToolOutput<O>>;
}
```

`effect` can depend on the arguments: `browser.act` is `read` for a scroll but `external` for a click on a
submit button ([F09](F09-browser.md) decides).

`ToolContext` gives a tool what it may use, and nothing else: the turn and session IDs, an `AbortSignal`, a
`TurnLock` for writes, the workspace or desktop client for its target, a logger, and the event bus.

### Execution pipeline (chain of responsibility)

```ts
interface ToolMiddleware {
  handle(call: ToolInvocation, next: () => Promise<ToolOutcome>): Promise<ToolOutcome>;
}
```

Default order, each in its own class:

| # | Middleware | Job |
|---|-----------|-----|
| 1 | `CancellationMiddleware` | Races the call against the turn's `AbortSignal`; never waits for a tool that ignores it |
| 2 | `ValidationMiddleware` | zod-parse the arguments; a failure returns the exact field errors to the model |
| 3 | `RepeatFailureMiddleware` | After N identical failures of one tool, end the run with the last specific cause |
| 4 | `ReceiptMiddleware` | Write `tool_start` / `tool_end` to `turn_events` with effect, target, outcome, duration, redacted arguments and the trust basis ([F22](F22-observability-and-cost.md)). It sits outside trust, so a refused call is in the activity log too |
| 5 | `TrustMiddleware` | Ask the trust service ([F11](F11-trust-and-approvals.md)): allow, ask, or deny |
| 6 | `ExecuteMiddleware` | Call `run()`, or forward to the workspace / desktop / MCP client for that target |
| 7 | `OutputLimitMiddleware` | Cap output size; keep head and tail; save the full output as a workspace file |
| 8 | `RedactionMiddleware` | Remove known secrets ([F12](F12-secrets-vault.md)) |
| 9 | `UntrustedWrapMiddleware` | Wrap `untrustedOutput` results in an `<untrusted_data>` block with a notice |

The pipeline is built in the composition root, so tests can run a tool with only the middlewares they need.

### Deferred discovery

A request carries **one** tools array, and providers put it at the very start of the cached prefix:
Anthropic's documented cache order is tools, then system prompt, then messages, and OpenAI-compatible
servers usually render tools at the start of the prompt too. Changing that array invalidates the cache
for the system prompt and the whole history. Models also limit how many tools they accept (128 for
OpenAI), and small local models degrade well before that.

So **the tools array is fixed for the life of a session**, however many tools exist:

| Part | Where it lives | Changes |
|------|----------------|---------|
| The **core set** (math, files, web, `tool_search`, `tool_call`, …) | The tools array, at the start of the cached prefix | Never during a session |
| Names of the deferred tools | Header: `ToolIndexInjectable` ([F04](F04-agent-runtime.md#placement-and-order)) | When tools are installed or removed |
| A found tool's full schema | The **result** of `tool_search`: new history at the end, which keeps the cache | Per search |
| Calling a found tool | `tool_call({ name, arguments })` | — |

- `tool_search({ query })` returns up to 5 matches; the top 3 strong matches include their full schema.
- `tool_call({ name, arguments })` is a gateway. The pipeline unwraps it before anything else, so
  validation (with field-level errors), trust, receipts and the repeated-failure check all apply to the
  real tool. It cannot call itself.
- **Trade-off:** a tool reached through the gateway does not get the provider's native schema
  enforcement; the model writes the arguments from the schema text. Validation catches mistakes and names
  the wrong field, which the model then fixes.
- **Promotion (later):** a deferred tool used often in a session could join the core set, but only when
  a new session starts or the history is compacted, the moments the cache is rebuilt anyway.
- **Core-set size per model:** small local models get a smaller core set (the `maxToolsPerRequest` quirk
  in [F03](F03-model-providers.md)).

This matters for local models with small context windows and for MCP servers with dozens of tools
([F18](F18-integrations-mcp.md)).

### Tool selection profiles

An agent profile ([F24](F24-agent-profiles.md)) or a model binding can restrict tools with `allow` / `exclude`
selectors (`workspace.*`, `mcp:gmail:*`). Exclude wins. An unknown selector selects nothing.

## Built-in tools after this feature

| Today | Becomes |
|-------|---------|
| `CalculatorTool` | `math.evaluate` (`compute`), core |
| `FileReadTool`, `FileWriteTool`, `FileListTool` | `workspace.read`, `workspace.write`, `workspace.list` — run in the workspace container ([F08](F08-workspace-sandbox.md)), not on the host |
| — | `workspace.send` (S33): attaches a file from the workspace or the handoff folder to the reply; effect `external` since S41 (X4), with a shipped `trust.rules` allow so it runs without a card ([F06](F06-channel-gateway.md)) |
| `ExecuteCommandTool` | `workspace.exec` in the sandbox; the prefix allowlist is removed because the container is the boundary |
| `SystemInfoTool` | `system.status`: Shitsuji's own health, not the host's |
| `WebSearchTool` | `web.search` behind a `SearchProvider` port (SearXNG container, Brave, Tavily…); `web.fetch` for readable page text; both `untrustedOutput` |

## Acceptance criteria

- Every built-in tool has a zod schema, an effect and a target.
- A call with invalid arguments returns field-level errors and no side effect.
- A tool that never resolves is abandoned within one second of Stop.
- With 40 deferred tools registered, the first request carries only the core set and the index.

## Risks and open questions

- Tool names with dots are not accepted by every provider. Use a mapping (`workspace__exec`) in the provider
  adapter, keep dotted names internally.
- How small should the core set be for local models? Measure with the eval harness
  ([F22](F22-observability-and-cost.md)).
