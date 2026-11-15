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
| 4 | `TrustMiddleware` | Ask the trust service ([F11](F11-trust-and-approvals.md)): allow, ask, or deny |
| 5 | `ReceiptMiddleware` | Write `tool_start` / `tool_end` to `turn_events` with redacted arguments ([F22](F22-observability-and-cost.md)) |
| 6 | `ExecuteMiddleware` | Call `run()`, or forward to the workspace / desktop / MCP client for that target |
| 7 | `OutputLimitMiddleware` | Cap output size; keep head and tail; save the full output as a workspace file |
| 8 | `RedactionMiddleware` | Remove known secrets ([F12](F12-secrets-vault.md)) |
| 9 | `UntrustedWrapMiddleware` | Wrap `untrustedOutput` results in an `<untrusted_data>` block with a notice |

The pipeline is built in the composition root, so tests can run a tool with only the middlewares they need.

### Deferred discovery

The prompt always lists a small **core set** (reply, ask, tool search, workspace exec, browser, memory, skills,
task). Other tools are `deferred`: the prompt lists their names in a short index, and the model calls:

- `tool_search({ query })` → up to 5 matches; the top 3 strong matches include their full schema;
- the found tool directly by name on the next step (the runtime adds its schema to the request).

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
