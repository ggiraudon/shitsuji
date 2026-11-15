/**
 * Contract tests on streams recorded from the real DeepSeek API (scripts/record-deepseek-fixtures.ts).
 * They check structure, not wording, so a re-recording keeps them green.
 */
import { describe, expect, it } from 'vitest';
import { NullLogger } from '../../../src/adapters/logging/loggers.js';
import { OpenAICompatibleProvider } from '../../../src/adapters/models/OpenAICompatibleProvider.js';
import { ExpressionEvaluator } from '../../../src/adapters/tools/ExpressionEvaluator.js';
import { complete } from '../../../src/application/modelCalls.js';
import { fixtureFetch } from '../../fixtures/fixtureFetch.js';

const deepseek = (fixture: string) =>
  new OpenAICompatibleProvider({
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    log: new NullLogger(),
    fetch: fixtureFetch({ fixture }).fetch,
  });

const ask = (text: string) => ({
  model: 'deepseek-flash',
  messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text }] }],
});

describe('recorded DeepSeek streams', () => {
  it('a plain reply: text, separate reasoning, usage with cache info, and stop', async () => {
    const result = await complete(deepseek('deepseek-recorded-text.sse'), ask('Greet me'));
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(result.reasoning.slice(0, 40));
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage!.inputTokens).toBeGreaterThan(0);
    expect(result.usage!.outputTokens).toBeGreaterThan(0);
    expect(result.usage!.cachedInputTokens).toBeTypeOf('number');
  });

  it('a tool call streamed token by token assembles into one valid calculator call', async () => {
    const result = await complete(deepseek('deepseek-recorded-tool-call.sse'), {
      ...ask('What is 48379 multiplied by 2917?'),
      tools: [{ name: 'calculator', description: 'Math', parameters: { type: 'object' } }],
    });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    const [call] = result.toolCalls;
    expect(call!.name).toBe('calculator');
    expect(call!.id).toMatch(/^call_/);
    const expression = call!.arguments.expression as string;
    expect(new ExpressionEvaluator().evaluate(expression)).toBe(48379 * 2917);
  });
});
