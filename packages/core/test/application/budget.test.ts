import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { BudgetService } from '../../src/application/budget/BudgetService.js';
import { estimateRequestCost } from '../../src/application/budget/estimate.js';
import { ModelCatalog } from '../../src/application/models/ModelCatalog.js';
import { BudgetExceeded } from '../../src/domain/errors.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { Money } from '../../src/domain/model/Money.js';
import type { ModelRequest } from '../../src/ports/ModelProvider.js';

const OWNER = asId<OwnerId>('owner');
const clock = new ManualClock('2026-03-15T12:00:00.000Z');

async function setup(limits = { monthly: Money.of(1), background: Money.of(0.5) }) {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'UTC',
    locale: 'en',
  });
  const log = new MemoryLogger();
  const budget = new BudgetService({ store: repos.budget, ownerId: OWNER, clock, log, limits });
  const usage = (amount: number, at: string, background = false) =>
    repos.usage.append({
      ownerId: OWNER,
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
