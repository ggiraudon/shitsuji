import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { SoulService } from '../../src/application/soul/SoulService.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { asId, type OwnerId, type ToolCallId } from '../../src/domain/model/ids.js';
import { DEFAULT_SOUL } from '../../src/domain/model/Soul.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { BaseTool, type ToolOutput } from '../../src/ports/Tool.js';
import { routerFor, testServices, until } from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

/** Echoes its argument; exists so the turn has a tool step after the first model call. */
class EchoTool extends BaseTool<z.ZodObject<{ text: z.ZodString }>> {
  readonly name = 'test.echo';
  readonly description = 'Echo';
  readonly input = z.object({ text: z.string() });
  readonly effect = 'read' as const;
  async run(input: { text: string }): Promise<ToolOutput> {
    return { content: input.text, isError: false };
  }
}

/**
 * First call waits until the test releases it, then asks for a tool; the second call answers. That
 * gives the test a moment in the middle of a turn to change the SOUL.
 */
class TwoStepModel implements ModelProvider {
  readonly id = 'soul-model';
  readonly requests: ModelRequest[] = [];
  private release?: () => void;
  waiting = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      this.waiting = true;
      await new Promise<void>((resolve) => (this.release = resolve));
      yield {
        type: 'tool_call',
        call: { id: asId<ToolCallId>('c1'), name: 'test.echo', arguments: { text: 'hi' } },
      };
      yield { type: 'done', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', text: 'Done.' };
    yield { type: 'done', finishReason: 'stop' };
  }

  releaseFirstCall(): void {
    this.release?.();
  }

  async listModels() {
    return [];
  }
}

async function setup() {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const clock = new ManualClock('2026-11-15T09:00:00.000Z');
  const log = new MemoryLogger();
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
  });
  const soul = new SoulService({ store: repos.soul, uow: repos.uow, ownerId: OWNER, clock, log });
  const tools = new ToolCatalog([new EchoTool()]);
  const model = new TwoStepModel();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const agent = new Agent({
    name: 'Test',
    ownerId: OWNER,
    models: routerFor(model),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    jobs,
    soul,
    ...services,
  });
  await jobs.start();
  await agent.start();
  return { agent, model, repos, soul };
}

describe('the SOUL and turns (S23)', () => {
  it('takes effect at the next turn, not in the middle of one', async () => {
    const { agent, model, repos, soul } = await setup();

    const first = agent.send('First request');
    await until(() => model.waiting);
    // A new revision lands while the turn is waiting on the model.
    await soul.edit('Be very terse.');
    model.releaseFirstCall();
    const firstTurn = await first;

    // Both calls of the first turn carried revision 1.
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      expect(request.system).toContain(DEFAULT_SOUL);
      expect(request.system).not.toContain('Be very terse.');
    }
    expect((await repos.turns.get(firstTurn.turnId))!.toProps().soulRevision).toBe(1);

    // The next turn gets revision 2.
    const second = await agent.send('Second request');
    const last = model.requests.at(-1)!;
    expect(last.system).toContain('Be very terse.');
    expect(last.system).not.toContain(DEFAULT_SOUL);
    expect((await repos.turns.get(second.turnId))!.toProps().soulRevision).toBe(2);
  });

  it('puts the SOUL after the identity and before the tool index in the system prompt', async () => {
    const { agent, model } = await setup();
    const pending = agent.send('hello');
    await until(() => model.waiting);
    model.releaseFirstCall();
    await pending;

    const system = model.requests[0]!.system!;
    expect(system.indexOf('You are Test')).toBeLessThan(system.indexOf(DEFAULT_SOUL));
    expect(system.indexOf(DEFAULT_SOUL)).toBeLessThan(system.indexOf('Guidelines:'));
  });
});
