import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/application/Agent.js';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../../src/adapters/events/InProcessEventBus.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { CalculatorTool } from '../../src/adapters/tools/CalculatorTool.js';
import type {
  LLMCompletionOptions,
  LLMProvider,
  LLMResponse,
} from '../../src/ports/LLMProvider.js';

/** A model that replies with the scripted responses in order. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly requests: LLMCompletionOptions[] = [];
  constructor(private readonly replies: Partial<LLMResponse>[]) {}
  async complete(options: LLMCompletionOptions): Promise<LLMResponse> {
    this.requests.push(structuredClone(options));
    const reply = this.replies.shift();
    if (!reply) throw new Error('No scripted reply left');
    return { id: 'r', model: 'm', content: '', finishReason: 'stop', ...reply };
  }
  getModels() {
    return ['m'];
  }
}

const setup = (replies: Partial<LLMResponse>[]) => {
  const log = new MemoryLogger();
  const events = new InProcessEventBus(log, new ManualClock());
  const seen: string[] = [];
  events.subscribePattern('*', (_p, e) => void seen.push(e.type));
  const llm = new ScriptedProvider(replies);
  const agent = new Agent({ name: 'Test', llmProvider: llm, log, events });
  return { agent, llm, seen, log };
};

describe('Agent', () => {
  it('replies with the model text and publishes session and model events', async () => {
    const { agent, seen } = setup([{ content: 'Hello!' }]);
    await expect(agent.send('Hi')).resolves.toBe('Hello!');
    expect(seen).toEqual([
      'session.created',
      'message.received',
      'llm.request',
      'llm.response',
      'message.sent',
    ]);
  });

  it('runs a tool call and sends the result back to the model', async () => {
    const { agent, llm, seen } = setup([
      { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '6 * 7' } }] },
      { content: 'It is 42.' },
    ]);
    agent.registerTool(new CalculatorTool());

    await expect(agent.send('What is 6 times 7?')).resolves.toBe('It is 42.');

    const toolMessage = llm.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ toolCallId: 'c1', content: '42' });
    expect(seen).toContain('tool.called');
    expect(seen).toContain('tool.result');
  });
});
