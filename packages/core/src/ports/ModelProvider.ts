import type { ContentPart, ToolCall } from '../domain/model/Message.js';

/** A tool as the model sees it: name, description and a JSON Schema for its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A message in a model request. The system prompt is separate (ModelRequest.system). */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: ContentPart[];
}

export interface ModelRequest {
  /** The provider's model name, e.g. "deepseek-flash". */
  model: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Who is asking, for metering and logs. Adapters ignore it. */
  metadata?: {
    purpose?: string;
    turnId?: string;
    sessionId?: string;
    /** True when no owner message started this work (tasks, schedules, events). */
    background?: boolean;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  /** Output tokens spent on reasoning, when reported. */
  reasoningTokens?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other';

export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  /** Model reasoning (DeepSeek and similar): kept out of the reply. */
  | { type: 'reasoning_delta'; text: string }
  /** Emitted only once the call's arguments are complete, valid JSON. */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason };

/**
 * One model endpoint (DeepSeek, Ollama, Anthropic…). Streaming is the only primitive; use
 * complete() from application/modelCalls.ts to collect a whole response.
 */
export interface ModelProvider {
  /** The id model refs use, e.g. "deepseek" in "deepseek/deepseek-flash". */
  readonly id: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Model names the endpoint offers, when it can list them; otherwise []. */
  listModels(signal?: AbortSignal): Promise<string[]>;
}
