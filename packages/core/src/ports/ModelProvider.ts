import type { ContentPart, ToolCall } from '../domain/model/Message.js';

/** A tool as the model sees it: name, description and a JSON Schema for its arguments. */
export interface ToolSpec {
  /** The tool's dotted name, as it will appear in a tool call. */
  name: string;
  /** The one or two sentences the model reads to decide when to call it. */
  description: string;
  /** Draft-7 JSON Schema of the arguments; the provider sends it verbatim. */
  parameters: Record<string, unknown>;
}

/** A message in a model request. The system prompt is separate (ModelRequest.system). */
export interface ModelMessage {
  /** The role the endpoint expects; tool results carry `tool`. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** The content, in transcript order; see the domain `ContentPart`. */
  parts: ContentPart[];
}

/** One chat request, as an adapter sends it. The core builds it in `TurnRunner.callModel`. */
export interface ModelRequest {
  /** The provider's model name, e.g. "deepseek-flash". */
  model: string;
  /** The assembled system prompt, when the context has one. */
  system?: string;
  /** The transcript, oldest first, with tool calls and results in place. */
  messages: ModelMessage[];
  /** The tools the model may call; omitted when empty, because some providers reject an empty list. */
  tools?: ToolSpec[];
  /** Sampling temperature; the runner uses 0.7. */
  temperature?: number;
  /** The reply budget in tokens; the runner uses 4096. */
  maxOutputTokens?: number;
  /**
   * How much reasoning the caller will pay for. `off` asks the adapter to disable thinking where the
   * endpoint can (`deepseek`'s `thinking` toggle); an endpoint that cannot is simply called as usual.
   * The compactor sets it, because a summary needs no chain of thought (#150).
   */
  reasoning?: 'off';
  /** Who is asking, for metering and logs. Adapters ignore it. */
  metadata?: {
    /** The routing purpose, e.g. `chat`; recorded in the usage row. */
    purpose?: string;
    /** The turn that made the request, when there is one. */
    turnId?: string;
    /** The session the request belongs to, when there is one. */
    sessionId?: string;
    /** True when no owner message started this work (tasks, schedules, events). */
    background?: boolean;
  };
}

/** What one request cost in tokens, as the provider reports it. */
export interface TokenUsage {
  /** Prompt tokens, cached ones included. */
  inputTokens: number;
  /** Generated tokens, reasoning included. */
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  /** Output tokens spent on reasoning, when reported. */
  reasoningTokens?: number;
}

/** Why the model stopped. `tool_calls` means the loop must run the calls and continue. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other';

/** One event of a streamed response; `done` is always last. */
export type ModelStreamEvent =
  | {
      /** A piece of the reply text. */
      type: 'text_delta';
      /** The new text since the previous delta. */
      text: string;
    }
  /** Model reasoning (DeepSeek and similar): kept out of the reply. */
  | {
      /** A piece of the model's reasoning. */
      type: 'reasoning_delta';
      /** The new reasoning text since the previous delta. */
      text: string;
    }
  /** Emitted only once the call's arguments are complete, valid JSON. */
  | {
      /** A complete tool call. */
      type: 'tool_call';
      /** The call, ready to validate and run. */
      call: ToolCall;
    }
  | {
      /** The token counts for the request, before `done`. */
      type: 'usage';
      /** What the request cost, as reported by the provider. */
      usage: TokenUsage;
    }
  | {
      /** The response ended; no further events follow. */
      type: 'done';
      /** Why it ended, e.g. `stop` or `tool_calls`. */
      finishReason: FinishReason;
    };

/**
 * One model endpoint (DeepSeek, Ollama, Anthropic…). Streaming is the only primitive; use
 * complete() from application/modelCalls.ts to collect a whole response.
 */
export interface ModelProvider {
  /** The id model refs use, e.g. "deepseek" in "deepseek/deepseek-flash". */
  readonly id: string;
  /** Streams one response; aborting the signal stops the request and the iteration. */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Model names the endpoint offers, when it can list them; otherwise []. */
  listModels(signal?: AbortSignal): Promise<string[]>;
}
