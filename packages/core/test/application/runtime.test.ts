import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { asId, type OwnerId, type ToolCallId } from '../../src/domain/model/ids.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { BaseTool, type ToolOutput } from '../../src/ports/Tool.js';
import { routerFor, testServices, transcript, until } from '../helpers.js';

type Step = {
  text?: string;
  tool?: { name: string; args?: Record<string, unknown> };
  hold?: boolean;
};

/**
 * A model driven by the test: each call takes the next step. `hold` makes the call wait until the
 * test calls release(), so a turn can be kept "running" while the test acts.
 */
class ControlledModel implements ModelProvider {
  readonly id = 'ctl';
  readonly requests: ModelRequest[] = [];
  private releases: (() => void)[] = [];
  constructor(private readonly steps: Step[]) {}
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift() ?? { text: 'done' };
    if (step.hold) {
      await new Promise<void>((resolve, reject) => {
        this.releases.push(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (step.text) {
      for (const piece of step.text.split(/(?<= )/)) yield { type: 'text_delta', text: piece };
    }
    if (step.tool) {
      yield {
        type: 'tool_call',
        call: {
          id: asId<ToolCallId>(`c${this.requests.length}`),
          name: step.tool.name,
          arguments: step.tool.args ?? {},
        },
      };
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'done', finishReason: step.tool ? 'tool_calls' : 'stop' };
  }
  release() {
    this.releases.shift()?.();
  }
  get waiting() {
    return this.releases.length;
  }
  async listModels() {
    return [];
  }
}

/** A tool that never finishes unless stopped. */
class HangTool extends BaseTool<z.ZodObject<Record<string, never>>> {
  readonly name = 'test.hang';
  readonly description = 'Never finishes';
  readonly input = z.object({});
  readonly effect = 'read' as const;
  started = 0;
  async run(): Promise<ToolOutput> {
    this.started++;
    return new Promise(() => {});
  }
}

class FailTool extends BaseTool<z.ZodObject<{ n: z.ZodOptional<z.ZodNumber> }>> {
  readonly name = 'test.fail';
  readonly description = 'Always fails, differently each time';
  readonly input = z.object({ n: z.number().optional() });
  readonly effect = 'read' as const;
  private count = 0;
  async run(): Promise<ToolOutput> {
    return { content: `failure ${++this.count}`, isError: true };
  }
}

async function setup(steps: Step[]) {
  const services = testServices();
  const events: string[] = [];
  services.events.subscribePattern('*', (p, e) => {
    if (e.type === 'turn.status') events.push(`turn.${(p as { status: string }).status}`);
    else if (
      e.type.startsWith('turn.') ||
      e.type.startsWith('tool.started') ||
      e.type.startsWith('tool.finished')
    )
      events.push(e.type);
  });
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const hang = new HangTool();
  const tools = new ToolCatalog([hang, new FailTool()]);
  const model = new ControlledModel(steps);
  const agent = new Agent({
    name: 'Test',
    ownerId: asId<OwnerId>('owner'),
    models: routerFor(model),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    jobs,
    ...services,
  });
  await jobs.start();
  await agent.start();
  return { agent, model, repos, events, hang, services };
}

describe('runtime: intake, scheduling and streaming (S20, S21)', () => {
  it('returns at once from submit(), then runs the turn and streams the reply', async () => {
    const { agent, repos, events } = await setup([{ text: 'Good evening, sir.' }]);
    const { turnId, steered } = await agent.submit('Hello');
    expect(steered).toBe(false);
    await agent.idle();
    await until(() => events.includes('turn.succeeded'));
    expect((await repos.turns.get(turnId))!.status).toBe('succeeded');
    expect(events).toEqual([
      'turn.queued',
      'turn.running',
      'turn.text_delta',
      'turn.text_delta',
      'turn.text_delta',
      'turn.succeeded',
    ]);
  });

  it('answers a message sent while the agent works in the same turn (F04)', async () => {
    const { agent, model, repos } = await setup([
      { text: 'Working on the first.', hold: true },
      { text: 'Both done.' },
    ]);
    const first = agent.send('First request');
    await until(() => model.waiting === 1);
    const second = await agent.submit('Also: second request');
    expect(second.steered).toBe(true);
    model.release();
    const { reply, turnId } = await first;
    expect(turnId).toBe(second.turnId);
    expect(reply).toBe('Both done.');
    expect(transcript(model.requests[1]!)).toEqual([
      'user:First request',
      'user:Also: second request',
      'assistant:Working on the first.',
    ]);
    expect(await repos.turns.listBySession(second.sessionId)).toHaveLength(1);
  });

  it('runs different sessions in parallel', async () => {
    const { agent, model } = await setup([
      { text: 'a', hold: true },
      { text: 'b', hold: true },
    ]);
    const one = agent.send('in main'); // creates the main chat session
    await until(() => model.waiting === 1);
    const other = await agent.startSession();
    const two = agent.send('in other', { sessionId: other });
    await until(() => model.waiting === 2); // both turns are in a model call at the same time
    model.release();
    model.release();
    expect((await Promise.all([one, two])).map((r) => r.reply).sort()).toEqual(['a', 'b']);
  });

  it('stops a stalled turn: three tool rounds in a row where every tool failed', async () => {
    const fail = { tool: { name: 'test.fail' } };
    const { agent } = await setup([fail, fail, fail, fail]);
    await expect(agent.send('try')).rejects.toThrow(/Stalled: 3 tool rounds/);
  });

  it('reports tool activity as tool.started / tool.finished events', async () => {
    const { agent, events } = await setup([
      { tool: { name: 'test.fail' } },
      { text: 'It failed.' },
    ]);
    await agent.send('go');
    expect(events.filter((e) => e.startsWith('tool.'))).toEqual(['tool.started', 'tool.finished']);
  });
});

describe('runtime: Stop (S22)', () => {
  it('stops a turn stuck in a tool within a second, cancels it and withdraws the request (F04)', async () => {
    const { agent, model, repos, hang } = await setup([{ tool: { name: 'test.hang' } }]);
    const pending = agent.send('Do the slow thing').catch((e: Error) => e);
    await until(() => hang.started === 1);
    const started = Date.now();
    const turnId = (await repos.turns.listByStatus('running'))[0]!.id;
    expect(await agent.stop(turnId)).toBe(true);
    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outcome).toBeInstanceOf(Error);
    expect((await repos.turns.get(turnId))!.toProps()).toMatchObject({
      status: 'cancelled',
      error: 'stopped by owner',
    });
    const [request] = await repos.messages.listBySession(
      (await repos.turns.get(turnId))!.sessionId,
    );
    expect(request).toMatchObject({ author: 'owner', withdrawn: true });
    expect(model.requests).toHaveLength(1);
  });

  it('a withdrawn request is not sent to the model again', async () => {
    const { agent, repos, hang, model } = await setup([
      { tool: { name: 'test.hang' } },
      { text: 'Fresh start.' },
    ]);
    const pending = agent.send('Book a flight').catch(() => undefined);
    await until(() => hang.started === 1);
    await agent.stop((await repos.turns.listByStatus('running'))[0]!.id);
    await pending;
    await agent.send('Never mind, what time is it?');
    const sent = transcript(model.requests[1]!);
    expect(sent).not.toContain('user:Book a flight');
    expect(sent.at(-1)).toBe('user:Never mind, what time is it?');
  });

  it('cancels a queued turn before it starts, and says false for a turn that is over', async () => {
    const { agent, repos, model } = await setup([{ text: 'answered' }]);
    // The in-memory queue runs jobs on the next timer tick, so the turn is still queued here.
    const queued = await agent.submit('never mind');
    expect(await agent.stop(queued.turnId)).toBe(true);
    await agent.idle();
    expect((await repos.turns.get(queued.turnId))!.status).toBe('cancelled');
    expect(model.requests).toHaveLength(0);

    const done = await agent.send('hello');
    expect(await agent.stop(done.turnId)).toBe(false);
  });
});

describe('runtime: replies go back where the message came from', () => {
  it('publishes the reply with its reply channel', async () => {
    const { agent, services } = await setup([{ text: 'Pong.' }]);
    const seen: { replyChannel?: string; reply?: string }[] = [];
    services.events.subscribe('turn.status', (e) => {
      if (e.status === 'succeeded') seen.push({ replyChannel: e.replyChannel, reply: e.reply });
    });
    await agent.send('Ping', { replyChannel: 'webhook:client-7' });
    expect(seen).toEqual([{ replyChannel: 'webhook:client-7', reply: 'Pong.' }]);
  });
});
