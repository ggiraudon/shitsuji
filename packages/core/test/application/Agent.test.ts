import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { Agent } from '../../src/application/Agent.js';
import { ApprovalService } from '../../src/application/trust/ApprovalService.js';
import { Approval } from '../../src/domain/model/Approval.js';
import {
  asId,
  newId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import { textOf } from '../../src/domain/model/Message.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import {
  routerFor,
  ScriptedProvider,
  testServices,
  transcript,
  type ScriptedReply,
} from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

const setup = async (
  replies: ScriptedReply[],
  extra: {
    limits?: { chat: number };
    provider?: ModelProvider & { requests: ModelRequest[] };
    sendTimeoutMs?: number;
    beforeAgent?: (services: ReturnType<typeof testServices>) => void;
  } = {},
) => {
  const { provider, beforeAgent, ...agentOptions } = extra;
  const services = testServices();
  const seen: string[] = [];
  services.events.subscribePattern('*', (_p, e) => void seen.push(e.type));
  beforeAgent?.(services);
  const repos = new InMemoryRepositories();
  const tools = new ToolCatalog();
  const llm = provider ?? new ScriptedProvider(replies);
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events: services.events,
    clock: services.clock,
    log: services.log,
  });
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
    approvals,
    ...services,
    ...agentOptions,
  });
  await jobs.start();
  await agent.start();
  return { agent, llm, seen, repos, services, approvals };
};

const calc = (expression: string, id = 'c1'): ScriptedReply => ({
  toolCalls: [{ id, name: 'math.evaluate', arguments: { expression } }],
});

/** A model call that blocks on its first call, then answers a second call, for steering tests. */
class DeferredProvider implements ModelProvider {
  readonly id = 'deferred';
  readonly requests: ModelRequest[] = [];
  private resolveFirst?: (text: string) => void;
  private markFirst?: () => void;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.markFirst = resolve;
  });
  private calls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.calls += 1;
    let text: string;
    if (this.calls === 1) {
      this.markFirst?.();
      text = await new Promise<string>((resolve) => {
        this.resolveFirst = resolve;
      });
    } else {
      text = 'Second answer.';
    }
    yield { type: 'text_delta', text };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'done', finishReason: 'stop' };
  }

  release(text: string): void {
    this.resolveFirst?.(text);
  }

  async listModels(): Promise<string[]> {
    return ['m'];
  }
}
class BlockingProvider implements ModelProvider {
  readonly id = 'blocking';
  readonly requests: ModelRequest[] = [];
  private release?: (error: Error) => void;
  private markStarted?: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.markStarted?.();
    await new Promise<never>((_, reject) => {
      this.release = reject;
    });
    yield { type: 'done', finishReason: 'stop' }; // unreachable; satisfies the generator
  }

  fail(error: Error): void {
    this.release?.(error);
  }

  async listModels(): Promise<string[]> {
    return ['m'];
  }
}

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

describe('TurnRunner terminal races (#94)', () => {
  /** Another process or recovery finishes the turn while the runner is still in its model call. */
  const finishElsewhere = async (repos: InMemoryRepositories, turnId: TurnId) => {
    const turn = await repos.turns.get(turnId);
    turn!.succeed(new Date());
    expect(await repos.turns.update(turn!, 'running')).toBe(true);
  };

  it('does not withdraw or publish when the failure save loses the race', async () => {
    const provider = new BlockingProvider();
    const { agent, repos, services } = await setup([], { provider });
    const statuses: string[] = [];
    services.events.subscribe('turn.status', (e) => void statuses.push(e.status));

    const submitted = await agent.submit('Hi');
    await provider.started;
    await finishElsewhere(repos, submitted.turnId);
    provider.fail(new Error('model failed after the turn ended'));
    await agent.idle();

    const stored = await repos.turns.get(submitted.turnId);
    expect(stored!.status).toBe('succeeded');
    expect(stored!.error).toBeUndefined();
    const owner = (await repos.messages.listBySession(submitted.sessionId)).find(
      (m) => m.author === 'owner',
    );
    expect(owner!.withdrawn).toBe(false);
    expect(statuses).not.toContain('failed');
    expect(statuses).not.toContain('cancelled');
  });

  it('does not withdraw or publish when a Stop loses the race', async () => {
    const provider = new BlockingProvider();
    const { agent, repos, services } = await setup([], { provider });
    const statuses: string[] = [];
    services.events.subscribe('turn.status', (e) => void statuses.push(e.status));

    const submitted = await agent.submit('Hi');
    await provider.started;
    await finishElsewhere(repos, submitted.turnId);
    expect(await agent.stop(submitted.turnId)).toBe(true);
    provider.fail(new Error('stopped'));
    await agent.idle();

    const stored = await repos.turns.get(submitted.turnId);
    expect(stored!.status).toBe('succeeded');
    expect(stored!.error).toBeUndefined();
    const owner = (await repos.messages.listBySession(submitted.sessionId)).find(
      (m) => m.author === 'owner',
    );
    expect(owner!.withdrawn).toBe(false);
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('failed');
  });
});

describe('Agent.send timeout (#96)', () => {
  it('rejects after the bounded wait and removes its turn.status subscription', async () => {
    const provider = new BlockingProvider();
    let statusListeners = 0;
    const { agent } = await setup([], {
      provider,
      sendTimeoutMs: 25,
      beforeAgent: (services) => {
        const subscribe = services.events.subscribe.bind(services.events);
        services.events.subscribe = ((type, handler) => {
          if (type !== 'turn.status') return subscribe(type, handler);
          statusListeners += 1;
          const off = subscribe(type, handler);
          return () => {
            statusListeners -= 1;
            off();
          };
        }) as typeof services.events.subscribe;
      },
    });

    await expect(agent.send('Hi')).rejects.toThrow(/did not finish within 25 ms/);
    expect(statusListeners).toBe(0);

    // Let the blocked model finish so the run and the test do not leak.
    await provider.started;
    provider.fail(new Error('late reply'));
    await agent.idle();
  });
});

describe('TurnRunner steering window (#97)', () => {
  it('answers a steered message even after more than ten later messages', async () => {
    const provider = new DeferredProvider();
    const { agent, repos } = await setup([], { provider });

    const submitted = await agent.submit('Start');
    await provider.firstStarted;
    const steer = await agent.submit('Steer: use the new plan');
    expect(steer.steered).toBe(true);

    // A tool-heavy turn leaves more than ten messages after the steer, pushing it out of any
    // fixed-size window.
    const session = (await repos.sessions.get(submitted.sessionId))!;
    for (let i = 0; i < 11; i++) {
      await repos.messages.append({
        id: newId(),
        threadId: session.threadId,
        sessionId: session.id,
        turnId: submitted.turnId,
        role: 'tool',
        author: 'system',
        parts: [
          { type: 'tool_result', toolCallId: asId(`c${i}`), content: String(i), isError: false },
        ],
        withdrawn: false,
        createdAt: new Date(),
      });
    }

    provider.release('First answer.');
    await agent.idle();

    const stored = await repos.messages.listBySession(submitted.sessionId);
    const replies = stored
      .filter((m) => m.author === 'assistant' && m.parts.some((p) => p.type === 'text'))
      .map(textOf);
    expect(replies.at(-1)).toBe('Second answer.');
    expect(provider.requests).toHaveLength(2);
    expect(transcript(provider.requests[1]!)).toContain('user:Steer: use the new plan');
  });
});

it('supersedes a pending card when the owner sends a new message (#51)', async () => {
  const { agent, repos } = await setup([{ content: 'First.' }, { content: 'Second.' }]);
  const first = await agent.send('Do the first thing');
  const card = Approval.request({
    id: asId<ApprovalId>('approval-1'),
    ownerId: OWNER,
    turnId: first.turnId,
    sessionId: first.sessionId,
    tool: 'test.notify',
    effect: 'external',
    target: 'core',
    actionHash: 'a'.repeat(64),
    arguments: { text: 'Hello' },
    summary: 'test.notify (external)',
    createdAt: new Date(),
  });
  await repos.approvals.insert(card);

  const second = await agent.send('Actually, do something else');

  expect(second.sessionId).toBe(first.sessionId);
  expect((await repos.approvals.get(card.id))!.status).toBe('expired');
});
