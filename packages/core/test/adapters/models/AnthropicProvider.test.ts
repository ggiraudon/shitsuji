import { describe, expect, it } from 'vitest';
import { NullLogger } from '../../../src/adapters/logging/loggers.js';
import { AnthropicProvider } from '../../../src/adapters/models/AnthropicMessagesProvider.js';
import { complete } from '../../../src/application/modelCalls.js';
import { ProviderError } from '../../../src/domain/errors.js';
import { asId, type ToolCallId } from '../../../src/domain/model/ids.js';
import type { ModelMessage, ModelRequest } from '../../../src/ports/ModelProvider.js';
import { fixtureFetch, type FakeReply } from '../../fixtures/fixtureFetch.js';

const provider = (...replies: FakeReply[]) => {
  const fake = fixtureFetch(...replies);
  const p = new AnthropicProvider({
    id: 'anthropic',
    apiKey: 'sk-ant-test',
    log: new NullLogger(),
    fetch: fake.fetch,
  });
  return { p, requests: fake.requests };
};

const request = (messages: ModelMessage[], extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-sonnet-5-5',
  system: 'You are Shitsuji.',
  messages,
  ...extra,
});
const user = (text: string): ModelMessage => ({ role: 'user', parts: [{ type: 'text', text }] });

describe('AnthropicProvider', () => {
  it('streams text, counts cached input, and sends the system prompt separately with a cache breakpoint', async () => {
    const { p, requests } = provider({ fixture: 'anthropic-text.sse' });
    const result = await complete(p, request([user('Hello')]));

    expect(result).toMatchObject({ text: 'Certainly, sir.', finishReason: 'stop' });
    expect(result.usage).toEqual({ inputTokens: 425, outputTokens: 6, cachedInputTokens: 400 });
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 4096,
        stream: true,
        system: [{ type: 'text', text: 'You are Shitsuji.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      },
    });
  });

  it('assembles a streamed tool_use block into a tool call', async () => {
    const { p, requests } = provider({ fixture: 'anthropic-tool-use.sse' });
    const result = await complete(
      p,
      request([user('6 times 7?')], {
        tools: [{ name: 'calculator', description: 'Math', parameters: { type: 'object' } }],
      }),
    );
    expect(result.text).toBe('Let me check.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_01', name: 'calculator', arguments: { expression: '6*7' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(requests[0]!.body!.tools).toEqual([
      { name: 'calculator', description: 'Math', input_schema: { type: 'object' } },
    ]);
  });

  it('sends tool calls and results as linked blocks, merging turns so roles alternate (bug 2)', async () => {
    const { p, requests } = provider({ fixture: 'anthropic-text.sse' });
    const call = (id: string, expression: string) => ({
      type: 'tool_call' as const,
      call: { id: asId<ToolCallId>(id), name: 'calculator', arguments: { expression } },
    });
    const result = (id: string, content: string) => ({
      type: 'tool_result' as const,
      toolCallId: asId<ToolCallId>(id),
      content,
      isError: false,
    });
    await complete(
      p,
      request([
        user('Compute two things'),
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Sure.' }, call('t1', '1+1'), call('t2', '2+2')],
        },
        { role: 'tool', parts: [result('t1', '2')] },
        { role: 'tool', parts: [{ ...result('t2', 'Error: boom'), isError: true }] },
        { role: 'system', parts: [{ type: 'text', text: 'Previous turn was interrupted.' }] },
        user('Thanks'),
      ]),
    );
    expect(requests[0]!.body!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Compute two things' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 't1', name: 'calculator', input: { expression: '1+1' } },
          { type: 'tool_use', id: 't2', name: 'calculator', input: { expression: '2+2' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '2' },
          { type: 'tool_result', tool_use_id: 't2', content: 'Error: boom', is_error: true },
          { type: 'text', text: '[Note] Previous turn was interrupted.' },
          { type: 'text', text: 'Thanks' },
        ],
      },
    ]);
  });

  it('keeps every message: there is no history cut in the adapter', async () => {
    const { p, requests } = provider({ fixture: 'anthropic-text.sse' });
    const many: ModelMessage[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(user(`q${i}`), { role: 'assistant', parts: [{ type: 'text', text: `a${i}` }] });
    }
    await complete(p, request([...many, user('last')]));
    expect((requests[0]!.body!.messages as unknown[]).length).toBe(61);
  });

  it('sends images as base64 or URL sources', async () => {
    const { p, requests } = provider({ fixture: 'anthropic-text.sse' });
    await complete(
      p,
      request([
        {
          role: 'user',
          parts: [
            { type: 'image', mediaType: 'image/png', data: 'AAAA' },
            { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/a.jpg' },
          ],
        },
      ]),
    );
    expect((requests[0]!.body!.messages as { content: unknown[] }[])[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.jpg' } },
    ]);
  });

  it('turns an overloaded error event into a retryable ProviderError', async () => {
    const { p } = provider({ fixture: 'anthropic-overloaded.sse' });
    const error = (await complete(p, request([user('x')])).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe('anthropic stream error (overloaded_error): Overloaded');
    expect(error.retryable).toBe(true);
  });

  it('reports HTTP errors with the API message', async () => {
    const { p } = provider({
      status: 401,
      body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    });
    const error = (await complete(p, request([user('x')])).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(error.message).toBe('anthropic returned HTTP 401: invalid x-api-key');
    expect(error.retryable).toBe(false);
  });
});
