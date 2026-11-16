import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { BudgetService } from '../../src/application/budget/BudgetService.js';
import { BudgetedModelProvider } from '../../src/application/budget/BudgetedModelProvider.js';
import { estimateRequestCost } from '../../src/application/budget/estimate.js';
import { MeteredModelProvider } from '../../src/application/models/decorators.js';
import { ModelCatalog } from '../../src/application/models/ModelCatalog.js';
import { ModelRouter } from '../../src/application/models/ModelRouter.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { BudgetExceeded } from '../../src/domain/errors.js';
import { asId, type OwnerId, type SessionId } from '../../src/domain/model/ids.js';
import { Money } from '../../src/domain/model/Money.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { ScriptedProvider, testServices } from '../helpers.js';

const OWNER = asId<OwnerId>('owner');
const clock = new ManualClock('2026-03-15T12:00:00.000Z');

async function setup(
  limits = { monthly: Money.of(1), background: Money.of(0.5) },
  checkIn = Money.of(10),
) {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'UTC',
    locale: 'en',
  });
  const log = new MemoryLogger();
  const budget = new BudgetService({
    store: repos.budget,
    ownerId: OWNER,
    clock,
    log,
    limits,
    checkIn,
  });
  const usage = (amount: number, at: string, background = false, sessionId?: SessionId) =>
    repos.usage.append({
      ownerId: OWNER,
      ...(sessionId && { sessionId }),
      provider: 'test',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      background,
      cost: Money.of(amount),
      at: new Date(at),
    });
  return { repos, budget, log, usage };
}

const owner = { background: false };
const background = { background: true };

describe('BudgetService (F22, S27)', () => {
  it('reserves a conservative maximum, then lets the usage row settle it', async () => {
    const { budget, usage } = await setup();

    const reservation = await budget.reserve(owner, Money.of(0.6));
    expect(reservation).toBeDefined();
    expect((await budget.spentThisMonth()).micros).toBe(600_000);

    await usage(0.4, '2026-03-15T12:01:00.000Z');
    await budget.settle(reservation, Money.of(0.4));

    expect((await budget.spentThisMonth()).micros).toBe(400_000);
  });

  it('checks in on one session since the owner last spoke', async () => {
    const { budget, usage } = await setup(undefined, Money.of(0.00001)); // 10 micros
    const s1 = asId<SessionId>('s1');
    const s2 = asId<SessionId>('s2');
    const s3 = asId<SessionId>('s3');
    await usage(0.00002, '2026-03-15T12:00:05.000Z', false, s1); // over
    await usage(0.000005, '2026-03-15T12:00:06.000Z', false, s2); // under
    await usage(0.00001, '2026-03-15T12:00:07.000Z', false, s3); // exactly the limit
    await usage(0.00005, '2026-03-15T11:59:00.000Z', false, s1); // before the owner's message

    const since = new Date('2026-03-15T12:00:00.000Z');
    expect(await budget.checkIn(s1, since)).toMatchObject({ over: true });
    expect((await budget.checkIn(s1, since)).spent.micros).toBe(20);
    expect(await budget.checkIn(s2, since)).toMatchObject({ over: false });
    expect(await budget.checkIn(s3, since)).toMatchObject({ over: false });
  });

  it('refuses background work past the monthly limit, but never your own messages', async () => {
    const { budget } = await setup({ monthly: Money.of(1), background: Money.of(1) });
    await budget.reserve(background, Money.of(0.9));

    await expect(budget.reserve(background, Money.of(0.2))).rejects.toThrow(
      /monthly spending limit of 1\.00 USD is reached/,
    );
    const mine = await budget.reserve(owner, Money.of(0.2));
    expect(mine).toBeDefined();
  });

  it('refuses background work past the background allowance even under the monthly limit', async () => {
    const { budget } = await setup({
      monthly: Money.of(10),
      background: Money.of(0.5),
    });
    await budget.reserve(background, Money.of(0.4));

    await expect(budget.reserve(background, Money.of(0.2))).rejects.toThrow(
      /background allowance of 0\.50 USD is reached/,
    );
  });

  it('refuses an unpriced background request but lets the owner run', async () => {
    const { budget, log } = await setup();

    const refusal = budget.reserve(background, undefined);
    await expect(refusal).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(refusal).rejects.toThrow(/has no known price/);
    await expect(budget.reserve(owner, undefined)).resolves.toBeUndefined();
    expect(log.records.some((r) => /no usable price/.test(r.message))).toBe(true);
  });

  it('treats a price in another currency as unknown', async () => {
    const { budget } = await setup();
    await expect(budget.reserve(background, Money.of(0.1, 'EUR'))).rejects.toThrow(
      /no known price/,
    );
    await expect(budget.reserve(owner, Money.of(0.1, 'EUR'))).resolves.toBeUndefined();
  });

  it('ignores spending from the previous month', async () => {
    const { budget, usage } = await setup({ monthly: Money.of(1), background: Money.of(1) });
    await usage(10, '2026-02-28T23:59:00.000Z');

    await expect(budget.reserve(background, Money.of(0.9))).resolves.toBeDefined();
  });

  it('releases a hold when the request did not happen', async () => {
    const { budget } = await setup();
    const reservation = await budget.reserve(background, Money.of(0.4));

    await budget.release(reservation);

    expect((await budget.spentThisMonth()).isZero()).toBe(true);
  });
});

describe('estimateRequestCost (S27)', () => {
  const catalog = new ModelCatalog([
    {
      ref: 'p/m',
      maxOutput: 100,
      price: { inputPerMTok: Money.of(1), outputPerMTok: Money.of(2) },
    },
  ]);

  it('prices a generous input estimate plus the allowed output', () => {
    const request: ModelRequest = {
      model: 'm',
      system: 'x'.repeat(300),
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'y'.repeat(300) }] }],
      maxOutputTokens: 50,
    };

    // 600 characters at 3 per token = 200 input tokens at $1/M, plus 50 output at $2/M.
    expect(estimateRequestCost(catalog, 'p/m', request)!.micros).toBe(300);
  });

  it('is unknown without a price or a catalogue entry', () => {
    const request: ModelRequest = { model: 'm', messages: [] };
    expect(estimateRequestCost(catalog, 'p/other', request)).toBeUndefined();
    expect(estimateRequestCost(new ModelCatalog(), 'p/m', request)).toBeUndefined();
  });
});

/** A provider that reports what it used and then fails before finishing: a dropped connection. */
class BreakingProvider implements ModelProvider {
  readonly id = 'breaking';
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    throw new Error('connection lost');
  }
  async listModels() {
    return [];
  }
}

const pricedCatalog = (withPrice = true) =>
  new ModelCatalog([
    {
      ref: 'scripted/m',
      maxOutput: 100,
      ...(withPrice && { price: { inputPerMTok: Money.of(1), outputPerMTok: Money.of(2) } }),
    },
  ]);

const requestFor = (background: boolean): ModelRequest => ({
  model: 'm',
  system: 'x'.repeat(300),
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
  maxOutputTokens: 100,
  metadata: { turnId: 't1', sessionId: 's1', background },
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('BudgetedModelProvider (S27)', () => {
  async function chain(
    replies: { content?: string }[] = [{ content: 'Hello.' }],
    limits = { monthly: Money.of(1), background: Money.of(1) },
  ) {
    const { repos, budget, log } = await setup(limits);
    const catalog = pricedCatalog();
    const raw = new ScriptedProvider(replies, 'scripted');
    const metered = new MeteredModelProvider(raw, {
      ownerId: OWNER,
      usage: repos.usage,
      catalog,
      clock,
      log,
    });
    return {
      provider: new BudgetedModelProvider(metered, { budget, catalog }),
      raw,
      repos,
      budget,
    };
  }

  it('holds before the request and settles with what the usage row cost', async () => {
    const { provider, repos, budget } = await chain();

    const events = await collect(provider.stream(requestFor(false)));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const rows = await repos.usage.listSince(OWNER, new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ background: false, sessionId: 's1' });
    expect(rows[0]!.cost!.micros).toBe(20);
    expect((await budget.spentThisMonth()).micros).toBe(20);
    expect((await repos.budget.heldSince(OWNER, new Date(0), 'USD')).isZero()).toBe(true);
  });

  it('releases the hold when the request fails before it finishes', async () => {
    const { repos, budget, log } = await setup();
    const catalog = pricedCatalog();
    const provider = new BudgetedModelProvider(new BreakingProvider(), { budget, catalog });

    await expect(collect(provider.stream(requestFor(false)))).rejects.toThrow('connection lost');

    expect((await budget.spentThisMonth()).isZero()).toBe(true);
    expect((await repos.budget.heldSince(OWNER, new Date(0), 'USD')).isZero()).toBe(true);
    expect(log.records.some((r) => r.level === 'error')).toBe(false); // releasing is routine
  });

  it('refuses background work before the provider is called', async () => {
    const { provider, raw } = await chain([{ content: 'Hello.' }], {
      monthly: Money.of(0.000001),
      background: Money.of(0.000001),
    });

    await expect(collect(provider.stream(requestFor(true)))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(raw.requests).toHaveLength(0);

    // The same limit does not stop your own message.
    await expect(collect(provider.stream(requestFor(false)))).resolves.toHaveLength(3);
    expect(raw.requests).toHaveLength(1);
  });

  it('refuses an unpriced background call before the provider is called', async () => {
    const { repos, budget, log } = await setup();
    const catalog = pricedCatalog(false);
    const raw = new ScriptedProvider([{ content: 'Hello.' }], 'scripted');
    const provider = new BudgetedModelProvider(
      new MeteredModelProvider(raw, {
        ownerId: OWNER,
        usage: repos.usage,
        catalog,
        clock,
        log,
      }),
      { budget, catalog },
    );

    await expect(collect(provider.stream(requestFor(true)))).rejects.toThrow(/no known price/);
    expect(raw.requests).toHaveLength(0);
  });
});

describe('budget through a turn (S27)', () => {
  it('refuses a background turn at the limit and still answers your own message', async () => {
    const services = testServices();
    const repos = new InMemoryRepositories();
    await repos.owners.upsert({
      id: OWNER,
      displayName: 'Jeanne',
      timezone: 'UTC',
      locale: 'en',
    });
    const catalog = new ModelCatalog([
      {
        ref: 'scripted/m',
        maxOutput: 100,
        price: { inputPerMTok: Money.of(1), outputPerMTok: Money.of(2) },
      },
    ]);
    const budget = new BudgetService({
      store: repos.budget,
      ownerId: OWNER,
      clock: services.clock,
      log: services.log,
      limits: { monthly: Money.of(0.000001), background: Money.of(0.000001) },
      checkIn: Money.of(10),
    });
    const raw = new ScriptedProvider([{ content: 'Good evening.' }], 'scripted');
    const metered = new MeteredModelProvider(raw, {
      ownerId: OWNER,
      usage: repos.usage,
      catalog,
      clock: services.clock,
      log: services.log,
    });
    const models = new ModelRouter(
      new Map([['scripted', new BudgetedModelProvider(metered, { budget, catalog })]]),
      { purposes: { chat: 'scripted/m' }, fallbacks: {} },
      catalog,
      services.log,
    );
    const tools = new ToolCatalog();
    const jobs = new InMemoryJobQueue(services.log, services.clock);
    const agent = new Agent({
      name: 'Test',
      ownerId: OWNER,
      models,
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

    await expect(agent.send('plan the week', { source: 'task' })).rejects.toThrow(
      /monthly spending limit/,
    );
    expect(raw.requests).toHaveLength(0); // refused before the provider was called

    const reply = await agent.send('Good evening?');
    expect(reply.reply).toBe('Good evening.');
    expect(raw.requests).toHaveLength(1);
  });
});
