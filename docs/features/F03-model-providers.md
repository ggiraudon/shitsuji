# F03 — Model providers and router

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 0 Foundations | 3 | M | F01 | F04, F22, F23, and every model call |

## What it is

A provider layer that works well with **bring-your-own-key** and **local** models: one generic
OpenAI-compatible adapter (DeepSeek, OpenRouter, Ollama, LocalAI, vLLM, LM Studio, Groq, Together…), a fixed
Anthropic adapter, a model catalogue that records each model's capabilities and price, and a router that picks
the right model for each purpose.

## Where Shitsuji is today

`BaseLLMProvider` with `complete()` and optional `stream()`, `OpenAIProvider` and `AnthropicProvider` over raw
`fetch`. `baseUrl` is configurable, so DeepSeek already works for plain chat. Problems: Anthropic tool calls are
sent as text ([bug 2](../00-current-state.md#bugs-and-gaps-found)), streaming tool calls break (bug 3), model
names are hard-coded, and there is no usage or price information.

## Inspiration

- **nod:** applies provider-specific settings when it opens a connection (system role for some models,
  thinking controls for Ollama, a small working window for routers whose model can change); unsupported
  reasoning efforts fall back to a supported one; model-request retries are bounded and never repeat a tool
  action; provider errors keep their real cause.
- **openbot:** detects local model servers (Ollama, LM Studio); backup models when a provider hits a usage
  limit.
- **OpenMausBot:** a **fast decision model** for cheap choices (routing, "is this routine?") at a fraction of a
  cent; tool selection lists to shrink the tool set for small local models.

## Design

### Port

```ts
export interface ModelProvider {
  readonly id: string;                              // "deepseek", "ollama-local", "anthropic"
  listModels(): Promise<ModelInfo[]>;               // from the API when it supports it, else from config
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }       // DeepSeek-R1 style reasoning, kept out of replies
  | { type: 'tool_call'; call: ToolCall }           // emitted only when the call's JSON is complete
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason };
```

`complete()` becomes a helper that collects a stream, so every provider implements one method. Streaming is the
default so the web UI and Telegram can show progress.

### Adapters

| Adapter | Covers | Notes |
|---------|--------|-------|
| `OpenAICompatibleProvider` | DeepSeek, OpenRouter, Ollama (`/v1`), LocalAI, vLLM, LM Studio, Groq, OpenAI | One class, configured per endpoint: `baseUrl`, key, header extras, and a `quirks` object |
| `AnthropicProvider` | Claude | Proper `tool_use` / `tool_result` blocks; system prompt separate; prompt-cache breakpoints |
| `OllamaNativeProvider` (later) | Ollama `/api/chat` | Only if the native API gives something `/v1` does not (thinking toggles, model pulls) |

`quirks` captures endpoint differences without subclasses:

```ts
interface ProviderQuirks {
  toolCalls: 'native' | 'json-in-text' | 'none';   // small local models often need 'json-in-text'
  systemRole: 'system' | 'developer' | 'user-prefix';
  parallelToolCalls: boolean;
  reasoningField?: 'reasoning_content' | 'reasoning';
  maxToolsPerRequest?: number;
}
```

For `json-in-text` models, a `TextToolCallParser` reads a fenced JSON block from the reply and turns it into a
`tool_call` event, so the agent loop never needs to know.

### Tool-call assembly

A `ToolCallAccumulator` collects argument fragments by index and emits a `tool_call` only when the JSON parses.
This fixes bug 3 for every OpenAI-compatible endpoint.

### Model catalogue

```ts
interface ModelInfo {
  ref: ModelRef;                     // "deepseek/deepseek-flash"
  contextWindow: number;
  maxOutput: number;
  capabilities: Set<'tools' | 'vision' | 'reasoning' | 'json_mode' | 'embeddings' | 'audio'>;
  price?: { inputPerMTok: Money; outputPerMTok: Money; cachedInputPerMTok?: Money };
}
```

Filled from configuration, overridable per model, and refreshed from `listModels()` where possible. A model
with no known price is allowed for chat started by you, but budgeted background work refuses it
([F22](F22-observability-and-cost.md)).

### Router (strategy)

Callers ask for a **purpose**, not a model:

```ts
type ModelPurpose = 'chat' | 'task' | 'helper' | 'classify' | 'summarize' | 'vision' | 'embed' | 'trust';

class ModelRouter {
  select(purpose: ModelPurpose, needs?: Capability[]): ModelBinding;   // provider + model + settings
  supports(purpose: ModelPurpose, capability: Capability): boolean;    // declared by models.catalog
}
```

`supports` is strict for vision: a model with no `capabilities` in `models.catalog` counts as **no
vision**, and core logs one startup warning naming it. Images are never sent to it. The other
capabilities keep the permissive default when the catalogue is silent, so an older configuration
does not lose its tools.

Example configuration for a DeepSeek-first setup:

```yaml
models:
  providers:
    deepseek:   { kind: openai-compatible, baseUrl: https://api.deepseek.com/v1, apiKey: ${DEEPSEEK_API_KEY} }
    openrouter: { kind: openai-compatible, baseUrl: https://openrouter.ai/api/v1, apiKey: ${OPENROUTER_API_KEY} }
    local:      { kind: openai-compatible, baseUrl: http://ollama:11434/v1, quirks: { toolCalls: json-in-text } }
  purposes:
    # decided: DeepSeek V4.1 Flash for every purpose except classify and embed (05-open-questions M1)
    chat:      deepseek/deepseek-flash
    task:      deepseek/deepseek-flash
    classify:  local/qwen3:4b        # cheap yes/no decisions, falls back to chat model if down
    summarize: deepseek/deepseek-flash
    vision:    deepseek/deepseek-flash  # V4.1 Flash accepts images; same model as chat
    embed:     local/nomic-embed-text
    trust:     deepseek/deepseek-flash
  fallbacks:
    chat: [openrouter/<another model>]
```

### Decorators

- `MeteredModelProvider` writes one usage row per request ([F22](F22-observability-and-cost.md)).
- `RetryingModelProvider` retries only transient failures (connection reset, 429 with `Retry-After`, 5xx)
  before any output, never after a tool call has been emitted.
- `RedactingModelProvider` removes known secrets from requests ([F12](F12-secrets-vault.md)).

## Changes to existing code

| File | Change |
|------|--------|
| `llm/types.ts` | → `ports/ModelProvider.ts`; `Message` gains content parts (text, image, tool call, tool result) |
| `llm/OpenAIProvider.ts` | → `adapters/models/OpenAICompatibleProvider.ts` with the accumulator and quirks |
| `llm/AnthropicProvider.ts` | Rewritten with proper tool blocks; no 20-message cut |
| `index.ts` provider selection | Removed; the router reads configuration |

## Acceptance criteria

- The same conversation with tool calls works on DeepSeek, an Ollama model and Claude, checked by a recorded
  contract test per adapter (HTTP fixtures, no live calls in CI).
- Streaming tool calls with fragmented arguments assemble correctly.
- Switching a purpose to another model is a configuration change only.
- Every model request writes a usage row with tokens and, where known, cost.

## Risks and open questions

- **Small local models and tools.** Tool use quality drops sharply below ~14B parameters. Mitigations:
  `json-in-text` mode, fewer tools per request (deferred discovery in [F05](F05-tool-system.md)), and routing
  only cheap purposes (`classify`, `embed`) to local models until better hardware arrives.
- **Reasoning content.** DeepSeek's reasoning output must not be shown as the reply, or sent back where the
  API forbids it. Keep it in a separate field and only in the transcript.
