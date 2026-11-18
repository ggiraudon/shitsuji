import { describe, expect, it } from 'vitest';
import { NullLogger } from '../../../src/adapters/logging/loggers.js';
import { OpenAICompatibleProvider } from '../../../src/adapters/models/OpenAICompatibleProvider.js';
import { complete } from '../../../src/application/modelCalls.js';
import { ProviderError } from '../../../src/domain/errors.js';
import { asId } from '../../../src/domain/model/ids.js';
import type { ModelRequest, ModelStreamEvent, ToolSpec } from '../../../src/ports/ModelProvider.js';
import { fixtureFetch, type FakeReply } from '../../fixtures/fixtureFetch.js';

const provider = (replies: FakeReply[], quirks?: unknown, id = 'deepseek') => {
  const fake = fixtureFetch(...replies);
  const p = new OpenAICompatibleProvider({
    id,
    baseUrl: 'https://api.deepseek.com/v1/',
    apiKey: 'sk-test',
    quirks,
    log: new NullLogger(),
    fetch: fake.fetch,
  });
  return { p, requests: fake.requests };
};

const calculator: ToolSpec = {
  name: 'calculator',
  description: 'Evaluate arithmetic',
  parameters: { type: 'object', properties: { expression: { type: 'string' } } },
};

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'deepseek-flash',
  system: 'You are Shitsuji.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
  ...extra,
});

const collect = async (stream: AsyncIterable<ModelStreamEvent>) => {
  const events: ModelStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
};

describe('OpenAICompatibleProvider: DeepSeek', () => {
  it('streams text and keeps reasoning separate, with usage including cache hits', async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-text.sse' }]);
    const events = await collect(p.stream(request()));

    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    const reasoning = events
      .flatMap((e) => (e.type === 'reasoning_delta' ? [e.text] : []))
      .join('');
    expect(text).toBe('Good evening, sir. 執事 at your service.');
    expect(reasoning).toBe('The user greets me. Reply briefly.');
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 120, outputTokens: 18, cachedInputTokens: 100, reasoningTokens: 9 },
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

    expect(requests[0]).toMatchObject({
      url: 'https://api.deepseek.com/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: {
        model: 'deepseek-flash',
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: 'You are Shitsuji.' },
          { role: 'user', content: 'Hello' },
        ],
      },
    });
  });

  it('assembles fragmented, interleaved streaming tool calls (bug 3)', async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-tool-calls.sse' }]);
    const result = await complete(p, request({ tools: [calculator] }));

    expect(result.toolCalls).toEqual([
      { id: 'call_a1', name: 'calculator', arguments: { expression: '6 * 7' } },
      { id: 'call_b2', name: 'web_search', arguments: { query: 'weather Paris' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(requests[0]!.body!.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate arithmetic',
          parameters: calculator.parameters,
        },
      },
    ]);
  });

  it('fails clearly when tool-call arguments never become valid JSON', async () => {
    const { p } = provider([{ fixture: 'deepseek-broken-tool-call.sse' }]);
    const error = await complete(p, request({ tools: [calculator] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/"calculator" has arguments that are not valid JSON/);
  });

  it("separates the context tail from the owner's words (#66)", async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-text.sse' }]);
    const tail =
      "[Context from Shitsuji, not the owner's words]\nCurrent local date and time for your owner: Wednesday, November 18, 2026 at 2:43 PM (UTC).";
    await complete(
      p,
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'typed yes' },
              { type: 'text', text: tail },
            ],
          },
        ],
      }),
    );

    // The tail ended up glued onto the owner's last word, and went out in a notification.
    expect(requests[0]!.body!.messages).toContainEqual({
      role: 'user',
      content: `typed yes\n\n${tail}`,
    });
  });

  it('keeps text parts separated around an image too (#66)', async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-text.sse' }]);
    await complete(
      p,
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', mediaType: 'image/png', data: 'AAAA' },
              { type: 'text', text: '[Context from Shitsuji]' },
              { type: 'text', text: 'It is 2:43 PM.' },
            ],
          },
        ],
      }),
    );

    expect(requests[0]!.body!.messages).toContainEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: '[Context from Shitsuji]\n\nIt is 2:43 PM.' },
      ],
    });
  });

  it('sends a whole conversation with tool calls, results and images in OpenAI format', async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-text.sse' }]);
    await complete(
      p,
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'What is in this picture, times 2?' },
              { type: 'image', mediaType: 'image/png', data: 'AAAA' },
            ],
          },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'never sent back' },
              {
                type: 'tool_call',
                call: { id: asId('c1'), name: 'calculator', arguments: { expression: '3*2' } },
              },
            ],
          },
          {
            role: 'tool',
            parts: [{ type: 'tool_result', toolCallId: asId('c1'), content: '6', isError: false }],
          },
          {
            role: 'system',
            parts: [{ type: 'text', text: 'Your previous turn was interrupted.' }],
          },
        ],
      }),
    );
    expect(requests[0]!.body!.messages).toEqual([
      { role: 'system', content: 'You are Shitsuji.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this picture, times 2?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"3*2"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '6' },
      { role: 'system', content: 'Your previous turn was interrupted.' },
    ]);
  });

  it('names the provider and the real cause in HTTP errors, and marks what is retryable', async () => {
    const { p: unauthorized } = provider([
      {
        status: 401,
        body: '{"error":{"message":"Authentication Fails, Your api key is invalid"}}',
      },
    ]);
    const e401 = (await complete(unauthorized, request()).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(e401).toBeInstanceOf(ProviderError);
    expect(e401.message).toBe(
      'deepseek returned HTTP 401: Authentication Fails, Your api key is invalid',
    );
    expect(e401.retryable).toBe(false);

    const { p: limited } = provider([
      { status: 429, headers: { 'retry-after': '20' }, body: '{"error":{"message":"Rate limit"}}' },
    ]);
    const e429 = (await complete(limited, request()).catch((e: unknown) => e)) as ProviderError;
    expect(e429.retryable).toBe(true);
    expect(e429.details).toMatchObject({ status: 429, retryAfterSeconds: 20 });
  });

  it('reports a connection failure as retryable', async () => {
    const p = new OpenAICompatibleProvider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      log: new NullLogger(),
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const error = (await complete(p, request()).catch((e: unknown) => e)) as ProviderError;
    expect(error.message).toMatch(/Cannot reach https:\/\/api\.deepseek\.com\/v1: fetch failed/);
    expect(error.retryable).toBe(true);
  });

  it('lists models', async () => {
    const { p, requests } = provider([
      {
        body: '{"object":"list","data":[{"id":"deepseek-flash"},{"id":"deepseek-reasoner"}]}',
      },
    ]);
    expect(await p.listModels()).toEqual(['deepseek-flash', 'deepseek-reasoner']);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.deepseek.com/v1/models' });
  });
});

describe('OpenAICompatibleProvider: Ollama and quirks', () => {
  it('reads an Ollama stream, with reasoning in the "reasoning" field and no API key', async () => {
    const fake = fixtureFetch({ fixture: 'ollama-text.sse' });
    const p = new OpenAICompatibleProvider({
      id: 'local',
      baseUrl: 'http://ollama:11434/v1',
      log: new NullLogger(),
      fetch: fake.fetch,
    });
    const result = await complete(p, request({ model: 'qwen3:4b' }));
    expect(result).toMatchObject({
      text: 'Hello there!',
      reasoning: 'short answer',
      finishReason: 'stop',
    });
    expect(fake.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('json-in-text: describes tools in the prompt and turns a fenced block into a tool call', async () => {
    const { p, requests } = provider(
      [{ fixture: 'ollama-json-in-text.sse' }],
      { toolCalls: 'json-in-text' },
      'local',
    );
    const result = await complete(p, request({ model: 'qwen3:4b', tools: [calculator] }));

    expect(result.text).toBe("I'll calculate that.");
    expect(result.toolCalls).toMatchObject([
      { name: 'calculator', arguments: { expression: '2+2' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    const body = requests[0]!.body!;
    expect(body.tools).toBeUndefined();
    const system = (body.messages as { role: string; content: string }[])[0]!;
    expect(system.content).toContain('```tool_call');
    expect(system.content).toContain('- calculator: Evaluate arithmetic');
  });

  it('user-prefix: sends the system prompt inside the first user message', async () => {
    const { p, requests } = provider([{ fixture: 'ollama-text.sse' }], {
      systemRole: 'user-prefix',
    });
    await complete(p, request());
    expect(requests[0]!.body!.messages).toEqual([
      { role: 'user', content: '[Instructions]\nYou are Shitsuji.\n[/Instructions]\n\nHello' },
    ]);
  });

  it('developer role and no parallel tool calls when asked', async () => {
    const { p, requests } = provider([{ fixture: 'deepseek-text.sse' }], {
      systemRole: 'developer',
      parallelToolCalls: false,
    });
    await complete(p, request({ tools: [calculator] }));
    const body = requests[0]!.body!;
    expect((body.messages as { role: string }[])[0]!.role).toBe('developer');
    expect(body.parallel_tool_calls).toBe(false);
  });

  it('rejects unknown quirks at construction', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          id: 'x',
          baseUrl: 'http://x',
          log: new NullLogger(),
          quirks: { tools: 'yes' },
        }),
    ).toThrow(/Invalid quirks/);
  });
});
