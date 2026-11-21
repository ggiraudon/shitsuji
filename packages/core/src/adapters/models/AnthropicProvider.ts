import { ProviderError } from '../../domain/errors.js';
import type { ContentPart, ImageAttachment } from '../../domain/model/Message.js';
import type { Logger } from '../../ports/Logger.js';
import type {
  FinishReason,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  TokenUsage,
} from '../../ports/ModelProvider.js';
import { httpError } from './http.js';
import { readSseData } from './sse.js';
import { TEXT_PART_SEPARATOR, joinTextParts } from './textParts.js';
import { ToolNameMap } from './toolNames.js';
import { ToolCallAccumulator, ToolCallArgumentsError } from './ToolCallAccumulator.js';

export interface AnthropicOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  log: Logger;
  /** Required by the API; used when the request does not set maxOutputTokens. */
  defaultMaxTokens?: number;
  /** Injected in tests to replay recorded HTTP responses. */
  fetch?: typeof fetch;
}

type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
};

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: 'text'; text: string } | ImageBlock>;
      is_error?: boolean;
    };

interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

type StreamEvent =
  | { type: 'message_start'; message: { usage?: AnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block: { type: string; id?: string; name?: string; text?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type?: string; message?: string } };

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Claude via the Messages API, streamed. Tool calls are real tool_use / tool_result blocks (bug 2),
 * the system prompt is sent separately with a prompt-cache breakpoint, and history is never cut here.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.id = options.id;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('GET', '/models', undefined, signal);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const response = await this.request('POST', '/messages', this.buildBody(request), signal);
    if (!response.body) throw new ProviderError(this.id, 'Streaming response has no body', true);

    const tools = new ToolCallAccumulator();
    const toolIndexes = new Set<number>();
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'other';

    for await (const data of readSseData(response.body)) {
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        throw new ProviderError(this.id, `Unreadable stream event: ${data.slice(0, 200)}`, true);
      }
      switch (event.type) {
        case 'message_start':
          addUsage(usage, event.message.usage);
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolIndexes.add(event.index);
            tools.add({
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            });
          } else if (event.content_block.type === 'text' && event.content_block.text) {
            yield { type: 'text_delta', text: event.content_block.text };
          }
          break;
        case 'content_block_delta': {
          const d = event.delta;
          if (d.type === 'text_delta')
            yield { type: 'text_delta', text: (d as { text: string }).text };
          else if (d.type === 'thinking_delta') {
            yield { type: 'reasoning_delta', text: (d as { thinking: string }).thinking };
          } else if (d.type === 'input_json_delta' && toolIndexes.has(event.index)) {
            tools.add({
              index: event.index,
              arguments: (d as { partial_json: string }).partial_json,
            });
          }
          break;
        }
        case 'message_delta':
          if (event.delta.stop_reason) finishReason = mapStop(event.delta.stop_reason);
          addUsage(usage, event.usage);
          break;
        case 'error':
          throw new ProviderError(
            this.id,
            `${this.id} stream error (${event.error.type ?? 'unknown'}): ${event.error.message ?? ''}`.trim(),
            event.error.type === 'overloaded_error' || event.error.type === 'api_error',
          );
        default:
          break; // content_block_stop, message_stop, ping
      }
    }

    try {
      const names = new ToolNameMap(request.tools);
      for (const call of tools.finish()) {
        yield { type: 'tool_call', call: { ...call, name: names.internal(call.name) } };
      }
    } catch (error) {
      if (error instanceof ToolCallArgumentsError) {
        throw new ProviderError(this.id, error.message, false, {}, { cause: error });
      }
      throw error;
    }
    yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? this.options.defaultMaxTokens ?? 4096,
      messages: toWireMessages(request.messages),
      stream: true,
    };
    if (request.system) {
      // A cache breakpoint after the system prompt: it is the same on every call of a session.
      body.system = [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }];
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: ToolNameMap.toWire(t.name),
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    return body;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': this.options.apiKey,
      'anthropic-version': '2023-06-01',
    };
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

/**
 * Domain messages → Anthropic messages. The API wants alternating user/assistant turns, tool results
 * inside a user turn right after the call, and no system messages in the list: system notes become
 * user text, and consecutive same-role messages are merged.
 */
function toWireMessages(messages: ModelMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content = joinTextRuns([...last.content, ...blocks]);
    else out.push({ role, content: joinTextRuns(blocks) });
  };
  for (const m of messages) {
    if (m.role === 'assistant') push('assistant', m.parts.flatMap(toAssistantBlock));
    else if (m.role === 'system')
      push('user', [{ type: 'text', text: `[Note] ${joinTextParts(m.parts)}` }]);
    else push('user', m.parts.flatMap(toUserBlock));
  }
  return out;
}

/**
 * Adjacent text blocks are read as one run and the API adds no separator between them, so a context
 * tail would run into the owner's last word; text that touches becomes one block (#66).
 */
function joinTextRuns(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const last = out.at(-1);
    if (block.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { ...last, text: `${last.text}${TEXT_PART_SEPARATOR}${block.text}` };
    } else {
      out.push(block);
    }
  }
  return out;
}

function toAssistantBlock(p: ContentPart): Block[] {
  if (p.type === 'text' && p.text) return [{ type: 'text', text: p.text }];
  if (p.type === 'tool_call') {
    return [
      {
        type: 'tool_use',
        id: p.call.id,
        name: ToolNameMap.toWire(p.call.name),
        input: p.call.arguments,
      },
    ];
  }
  return []; // reasoning parts are not sent back
}

function toUserBlock(p: ContentPart): Block[] {
  switch (p.type) {
    case 'text':
      return p.text ? [{ type: 'text', text: p.text }] : [];
    case 'image':
      return [imageBlock(p)];
    case 'tool_result': {
      const images = p.images?.map(imageBlock) ?? [];
      return [
        {
          type: 'tool_result',
          tool_use_id: p.toolCallId,
          content: images.length
            ? [...(p.content ? [{ type: 'text' as const, text: p.content }] : []), ...images]
            : p.content,
          ...(p.isError && { is_error: true }),
        },
      ];
    }
    default:
      return [];
  }
}

function imageBlock(image: ImageAttachment): ImageBlock {
  return {
    type: 'image',
    source: image.url
      ? { type: 'url', url: image.url }
      : { type: 'base64', media_type: image.mediaType, data: image.data ?? '' },
  };
}

function addUsage(total: TokenUsage, u?: AnthropicUsage): void {
  if (!u) return;
  if (u.input_tokens !== undefined) {
    total.inputTokens =
      u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  if (u.cache_read_input_tokens !== undefined) total.cachedInputTokens = u.cache_read_input_tokens;
  if (u.output_tokens !== undefined) total.outputTokens = u.output_tokens;
}

function mapStop(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}
