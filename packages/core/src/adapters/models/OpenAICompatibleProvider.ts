import { z } from 'zod';
import { ProviderError } from '../../domain/errors.js';
import type { ContentPart } from '../../domain/model/Message.js';
import type { Logger } from '../../ports/Logger.js';
import type {
  FinishReason,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  TokenUsage,
} from '../../ports/ModelProvider.js';
import { readSseData } from './sse.js';
import { TextToolCallParser } from './TextToolCallParser.js';
import { ToolCallAccumulator, ToolCallArgumentsError } from './ToolCallAccumulator.js';

/** Endpoint differences, captured as data instead of subclasses (F03). */
export const providerQuirksSchema = z
  .object({
    /** 'json-in-text' for small local models that cannot call tools natively. */
    toolCalls: z.enum(['native', 'json-in-text', 'none']).default('native'),
    /** How the system prompt is sent: as a system/developer message or prefixed to the first user one. */
    systemRole: z.enum(['system', 'developer', 'user-prefix']).default('system'),
    parallelToolCalls: z.boolean().default(true),
    /** Where the endpoint streams reasoning: DeepSeek uses reasoning_content, others reasoning. */
    reasoningField: z.enum(['reasoning_content', 'reasoning']).optional(),
    /** Ask the endpoint for a final usage chunk (stream_options.include_usage). */
    streamUsage: z.boolean().default(true),
  })
  .strict();

export type ProviderQuirks = z.infer<typeof providerQuirksSchema>;

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  quirks?: unknown;
  log: Logger;
  /** Injected in tests to replay recorded HTTP responses. */
  fetch?: typeof fetch;
}

interface ChunkChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: {
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

interface Chunk {
  choices?: ChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number; // DeepSeek
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { message?: string };
}

/**
 * One adapter for every OpenAI-compatible endpoint: DeepSeek, OpenRouter, Ollama (/v1), LocalAI, vLLM,
 * LM Studio, Groq, OpenAI. Streams /chat/completions and normalises it to ModelStreamEvents.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly quirks: ProviderQuirks;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const quirks = providerQuirksSchema.safeParse(options.quirks ?? {});
    if (!quirks.success) {
      throw new ProviderError(
        options.id,
        `Invalid quirks: ${quirks.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        false,
      );
    }
    this.quirks = quirks.data;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('GET', '/models', undefined, signal);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const textMode = this.quirks.toolCalls === 'json-in-text' && !!request.tools?.length;
    const body = this.buildBody(request, textMode);
    const response = await this.request('POST', '/chat/completions', body, signal);
    if (!response.body) throw new ProviderError(this.id, 'Streaming response has no body', true);

    const accumulator = new ToolCallAccumulator();
    let finishReason: FinishReason = 'other';
    let bufferedText = '';
    let usage: TokenUsage | undefined;

    for await (const data of readSseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        throw new ProviderError(this.id, `Unreadable stream chunk: ${data.slice(0, 200)}`, true);
      }
      if (chunk.error) {
        throw new ProviderError(this.id, `Stream error: ${chunk.error.message ?? 'unknown'}`, true);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const reasoning = this.reasoningOf(delta);
        if (reasoning) yield { type: 'reasoning_delta', text: reasoning };
        if (delta.content) {
          if (textMode) bufferedText += delta.content;
          else yield { type: 'text_delta', text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          accumulator.add({
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          });
        }
      }
      if (choice?.finish_reason) finishReason = mapFinish(choice.finish_reason);
      if (chunk.usage) usage = mapUsage(chunk.usage);
    }

    if (textMode) {
      const parsed = new TextToolCallParser(request.tools!).parse(bufferedText);
      if (parsed.text) yield { type: 'text_delta', text: parsed.text };
      for (const call of parsed.calls) yield { type: 'tool_call', call };
      if (parsed.calls.length) finishReason = 'tool_calls';
    } else {
      try {
        for (const call of accumulator.finish()) yield { type: 'tool_call', call };
      } catch (error) {
        if (error instanceof ToolCallArgumentsError) {
          throw new ProviderError(this.id, error.message, false, {}, { cause: error });
        }
        throw error;
      }
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }

  private reasoningOf(delta: NonNullable<ChunkChoice['delta']>): string | undefined {
    if (this.quirks.reasoningField) return delta[this.quirks.reasoningField] ?? undefined;
    return delta.reasoning_content ?? delta.reasoning ?? undefined;
  }

  private buildBody(request: ModelRequest, textMode: boolean): Record<string, unknown> {
    let system = request.system ?? '';
    if (textMode)
      system = [system, TextToolCallParser.instructions(request.tools!)]
        .filter(Boolean)
        .join('\n\n');

    const messages = request.messages.flatMap((m) => this.toWire(m, textMode));
    if (system) {
      if (this.quirks.systemRole === 'user-prefix') {
        const first = messages.find((m) => m.role === 'user');
        if (first && typeof first.content === 'string') {
          first.content = `[Instructions]\n${system}\n[/Instructions]\n\n${first.content}`;
        } else {
          messages.unshift({ role: 'user', content: `[Instructions]\n${system}\n[/Instructions]` });
        }
      } else {
        messages.unshift({ role: this.quirks.systemRole, content: system });
      }
    }

    const body: Record<string, unknown> = { model: request.model, messages, stream: true };
    if (this.quirks.streamUsage) body.stream_options = { include_usage: true };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.tools?.length && this.quirks.toolCalls === 'native') {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (!this.quirks.parallelToolCalls) body.parallel_tool_calls = false;
    }
    return body;
  }

  /** One domain message → OpenAI wire messages (a tool message with several results becomes several). */
  private toWire(m: ModelMessage, textMode: boolean): WireMessage[] {
    const text = (parts: ContentPart[]) =>
      parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    switch (m.role) {
      case 'system':
        return [
          this.quirks.systemRole === 'user-prefix'
            ? { role: 'user', content: `[Note] ${text(m.parts)}` }
            : { role: this.quirks.systemRole, content: text(m.parts) },
        ];
      case 'user': {
        const images = m.parts.filter((p) => p.type === 'image');
        if (!images.length) return [{ role: 'user', content: text(m.parts) }];
        return [
          {
            role: 'user',
            content: m.parts.flatMap((p): unknown[] =>
              p.type === 'text'
                ? [{ type: 'text', text: p.text }]
                : p.type === 'image'
                  ? [
                      {
                        type: 'image_url',
                        image_url: { url: p.url ?? `data:${p.mediaType};base64,${p.data}` },
                      },
                    ]
                  : [],
            ),
          },
        ];
      }
      case 'assistant': {
        // Reasoning parts are never sent back (DeepSeek rejects them in requests).
        const calls = m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));
        if (textMode) {
          const blocks = calls.map(
            (c) =>
              '```tool_call\n' + JSON.stringify({ name: c.name, arguments: c.arguments }) + '\n```',
          );
          return [
            { role: 'assistant', content: [text(m.parts), ...blocks].filter(Boolean).join('\n') },
          ];
        }
        const wire: WireMessage = { role: 'assistant', content: text(m.parts) || null };
        if (calls.length) {
          wire.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
        }
        return [wire];
      }
      case 'tool':
        return m.parts.flatMap((p) =>
          p.type !== 'tool_result'
            ? []
            : textMode
              ? [{ role: 'user', content: `[Tool result for ${p.toolCallId}]\n${p.content}` }]
              : [{ role: 'tool', tool_call_id: p.toolCallId, content: p.content }],
        );
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.options.headers };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ProviderError(
        this.id,
        `Cannot reach ${this.baseUrl}: ${(error as Error).message}`,
        true,
        {},
        { cause: error },
      );
    }
    if (!response.ok) throw await httpError(this.id, response);
    return response;
  }
}

type WireMessage = {
  role: string;
  content: string | null | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
};

async function httpError(provider: string, response: Response): Promise<ProviderError> {
  const raw = await response.text().catch(() => '');
  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const msg =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (msg) detail = msg;
  } catch {
    // keep the raw text
  }
  const retryable = response.status === 429 || response.status >= 500;
  const retryAfter = Number(response.headers.get('retry-after'));
  return new ProviderError(
    provider,
    `${provider} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${detail}`,
    retryable,
    {
      status: response.status,
      ...(Number.isFinite(retryAfter) && { retryAfterSeconds: retryAfter }),
    },
  );
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

function mapUsage(u: NonNullable<Chunk['usage']>): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  };
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}
