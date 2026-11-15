import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { Agent } from '../../src/application/Agent.js';
import { asId, type OwnerId, type SessionId } from '../../src/domain/model/ids.js';
import { textOf } from '../../src/domain/model/Message.js';
import {
  routerFor,
  ScriptedProvider,
  testServices,
  transcript,
  type ScriptedReply,
} from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

const setup = async (replies: ScriptedReply[], extra: { limits?: { chat: number } } = {}) => {
  const services = testServices();
  const seen: string[] = [];
  services.events.subscribePattern('*', (_p, e) => void seen.push(e.type));
  const repos = new InMemoryRepositories();
  const tools = new ToolCatalog();
  const llm = new ScriptedProvider(replies);
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const agent = new Agent({
    name: 'Test',
    ownerId: OWNER,
    models: routerFor(llm),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    jobs,
    ...services,
    ...extra,
  });
  await jobs.start();
  await agent.start();
  return { agent, llm, seen, repos, services };
};

const calc = (expression: string, id = 'c1'): ScriptedReply => ({
  toolCalls: [{ id, name: 'math.evaluate', arguments: { expression } }],
});

describe('Agent', () => {
  it('replies with the model text and publishes session and model events', async () => {
    const { agent, seen } = await setup([{ content: 'Hello!' }]);
    const result = await agent.send('Hi');
    expect(result.reply).toBe('Hello!');
    expect(seen).toEqual([
      'session.created',
      'message.received',
      'turn.status', // queued
      'turn.status', // running
      'llm.request',
      'turn.text_delta',
      'llm.response',
      'message.sent',
      'turn.status', // succeeded
    ]);
  });

  it('keeps one conversation: the second message sees the first exchange (bug 1)', async () => {
    const { agent, llm } = await setup([
      { content: 'Nice to meet you, Sam.' },
      { content: 'You are Sam.' },
    ]);
    const first = await agent.send('My name is Sam');
    const second = await agent.send('What is my name?');
    expect(second.sessionId).toBe(first.sessionId);
    expect(transcript(llm.requests[1]!)).toEqual([
      'user:My name is Sam',
      'assistant:Nice to meet you, Sam.',
      'user:What is my name?',
    ]);
  });

  it('runs a tool call, stores call and result as content parts, and answers', async () => {
    const { agent, llm, repos, seen } = await setup([calc('6 * 7'), { content: 'It is 42.' }]);
    agent.registerTool(new MathEvaluateTool());

    const { reply, sessionId } = await agent.send('What is 6 times 7?');

    expect(reply).toBe('It is 42.');
    const toolMessage = llm.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMessage!.parts).toEqual([
      { type: 'tool_result', toolCallId: 'c1', content: '42', isError: false },
    ]);
    const stored = await repos.messages.listBySession(sessionId);
    expect(stored.map((m) => [m.role, m.author, m.parts.map((p) => p.type).join('+')])).toEqual([
      ['user', 'owner', 'text'],
      ['assistant', 'assistant', 'tool_call'],
      ['tool', 'system', 'tool_result'],
      ['assistant', 'assistant', 'text'],
    ]);
    expect(seen).toEqual(expect.arrayContaining(['tool.called', 'tool.result']));
  });

  it('records the turn as succeeded, with model and tool events', async () => {
    const { agent, repos } = await setup([calc('1+1'), { content: '2' }]);
    agent.registerTool(new MathEvaluateTool());
    const { turnId } = await agent.send('1+1?');
    const turn = await repos.turns.get(turnId);
    expect(turn!.status).toBe('succeeded');
    const kinds = (await repos.turnEvents.listByTurn(turnId)).map((e) => e.kind);
    expect(kinds).toEqual(['model_call', 'tool_start', 'tool_end', 'model_call']);
  });

  it('marks the turn failed with the reason when the model fails, and rethrows', async () => {
    const { agent, repos } = await setup([]); // no scripted reply: the model call throws
    await expect(agent.send('Hi')).rejects.toThrow('No scripted reply left');
    const [turn] = await repos.turns.listByStatus('failed');
    expect(turn!.error).toBe('No scripted reply left');
    // The owner's message is kept even though the turn failed.
    const messages = await repos.messages.listBySession(turn!.sessionId);
    expect(messages.map(textOf)).toEqual(['Hi']);
  });

  it('stops a runaway tool loop at the step limit (bug 4)', async () => {
    const loops = Array.from({ length: 5 }, (_, i) => calc('1', `c${i}`));
    const { agent, repos } = await setup(loops, { limits: { chat: 3 } });
    agent.registerTool(new MathEvaluateTool());
    await expect(agent.send('loop')).rejects.toThrow(/step limit for chat sessions/);
    const [turn] = await repos.turns.listByStatus('failed');
    expect(turn!.error).toMatch(/after 3 model calls/);
  });

  it('keeps reasoning in the transcript but never in the reply (F03)', async () => {
    const { agent, repos } = await setup([{ reasoning: 'They want brevity.', content: 'Done.' }]);
    const { reply, sessionId } = await agent.send('Be brief');
    expect(reply).toBe('Done.');
    const [, assistant] = await repos.messages.listBySession(sessionId);
    expect(assistant!.parts).toEqual([
      { type: 'reasoning', text: 'They want brevity.' },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('starts separate sessions on request', async () => {
    const { agent, llm } = await setup([{ content: 'a' }, { content: 'b' }]);
    const main = await agent.send('first');
    const fresh = await agent.startSession();
    const other = await agent.send('second', { sessionId: fresh });
    expect(other.sessionId).not.toBe(main.sessionId);
    expect(llm.requests[1]!.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('refuses a session that does not exist', async () => {
    const { agent } = await setup([]);
    await expect(agent.send('x', { sessionId: asId<SessionId>('nope') })).rejects.toThrow(
      /not found/,
    );
  });

  it('carries the clock in the tail, never in the system prompt (S23)', async () => {
    const { agent, llm } = await setup([{ content: "Ten o'clock." }]);
    await agent.send('What time is it?');
    const request = llm.requests[0]!;
    expect(request.system).not.toContain('Current local date and time');
    expect(JSON.stringify(request.messages.at(-1))).toContain('Current local date and time');
  });

  it('applies tool_used injectables only after that tool ran (bug 8)', async () => {
    const { agent, llm } = await setup([calc('2+2'), { content: '4' }]);
    agent.registerTool(new MathEvaluateTool());
    agent.addInjectable({
      id: 'calc-hint',
      name: 'hint',
      description: '',
      placement: 'header',
      order: 10,
      condition: { type: 'tool_used', toolNames: ['math.evaluate'] },
      render: () => 'CALCULATOR WAS USED',
    });
    await agent.send('2+2?');
    expect(llm.requests[0]!.system).not.toContain('CALCULATOR WAS USED');
    expect(llm.requests[1]!.system).toContain('CALCULATOR WAS USED');
  });
});
