import { describe, expect, it } from 'vitest';
import { InMemoryRepositories } from '../../../src/adapters/memory/InMemoryRepositories.js';
import { actionRequest } from '../../../src/application/trust/ActionRequest.js';
import { ApprovalService } from '../../../src/application/trust/ApprovalService.js';
import type { Authority } from '../../../src/application/trust/Authority.js';
import { PolicyEngine } from '../../../src/application/trust/PolicyEngine.js';
import { TrustService } from '../../../src/application/trust/TrustService.js';
import type { TrustCheck } from '../../../src/application/trust/TrustPolicy.js';
import { asId, type ApprovalId, type OwnerId } from '../../../src/domain/model/ids.js';
import { testServices, until } from '../../helpers.js';

const check = (signal = new AbortController().signal): TrustCheck => ({
  turnId: 'turn-1',
  sessionId: 'session-1',
  signal,
});

const payment = actionRequest({
  tool: 'shop.pay',
  arguments: { amount: '10 EUR' },
  effect: 'payment',
  target: 'core',
});

async function setup(options: { backgroundWaitMs?: number } = {}) {
  const repos = new InMemoryRepositories();
  const services = testServices();
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events: services.events,
    clock: services.clock,
    log: services.log,
  });
  const authority: Authority = { words: ['Pay the invoice.'], rules: [] };
  const trust = new TrustService({
    engine: new PolicyEngine(),
    authority: { forTurn: async () => authority },
    approvals,
    ownerId: asId<OwnerId>('owner'),
    log: services.log,
    ...(options.backgroundWaitMs !== undefined && {
      backgroundApprovalWaitMs: options.backgroundWaitMs,
    }),
  });
  const requested: string[] = [];
  services.events.subscribe('approval.requested', (e) => {
    requested.push(e.approvalId);
  });
  return { trust, approvals, requested, repos, services };
}

describe('TrustService with approvals (S36, F11)', () => {
  it('asks the owner for a payment and allows it only after a yes', async () => {
    const { trust, approvals, requested } = await setup();
    const deciding = trust.decide(payment, check());
    await until(() => requested.length === 1);
    const id = asId<ApprovalId>(requested[0]!);

    await approvals.resolve(id, 'approve');
    const decision = await deciding;

    expect(decision).toMatchObject({
      verdict: 'allow',
      basis: { kind: 'owner', detail: 'the owner approved this exact action' },
      approvalId: id,
      actionHash: payment.hash,
    });
  });

  it('refuses when the owner declines', async () => {
    const { trust, approvals, requested } = await setup();
    const deciding = trust.decide(payment, check());
    await until(() => requested.length === 1);

    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'decline');
    const decision = await deciding;

    expect(decision).toMatchObject({ verdict: 'deny', basis: { kind: 'none' } });
    expect(decision.reason).toMatch(/declined/);
  });

  it('refuses when the turn stops while the card is open', async () => {
    const { trust, requested, repos } = await setup();
    const controller = new AbortController();
    const deciding = trust.decide(payment, check(controller.signal));
    await until(() => requested.length === 1);

    controller.abort();
    const decision = await deciding;

    expect(decision).toMatchObject({ verdict: 'deny' });
    expect(decision.reason).toMatch(/expired/);
    expect((await repos.approvals.get(asId<ApprovalId>(requested[0]!)))!.status).toBe('expired');
  });

  it('does not ask for reads or for actions the engine allows', async () => {
    const { trust, requested } = await setup();

    const read = await trust.decide(
      actionRequest({
        tool: 'workspace.read',
        arguments: { path: 'a.txt' },
        effect: 'read',
        target: 'core',
      }),
      check(),
    );

    expect(read.verdict).toBe('allow');
    expect(requested).toEqual([]);
  });

  it('stores only a shortened copy of the arguments, while the hash binds the exact action', async () => {
    const { trust, approvals, requested, repos } = await setup();
    const long = actionRequest({
      tool: 'mail.send',
      arguments: { body: 'x'.repeat(2_000) },
      effect: 'payment',
      target: 'core',
    });
    const deciding = trust.decide(long, check());
    await until(() => requested.length === 1);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'decline');
    await deciding;

    const stored = (await repos.approvals.get(asId<ApprovalId>(requested[0]!)))!.toProps();
    expect(stored.actionHash).toBe(long.hash);
    expect((stored.arguments.body as string).length).toBeLessThan(600);
  });
});

describe('TrustService: the turn fence (F11, S36)', () => {
  it('asks again for an action whose approval never finished: it may have run', async () => {
    const { trust, approvals, requested } = await setup();
    const first = trust.decide(payment, check());
    await until(() => requested.length === 1);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'approve');
    expect((await first).verdict).toBe('allow'); // finish() never ran, so the card stays approved

    const second = trust.decide(payment, check());
    await until(() => requested.length === 2);
    await approvals.resolve(asId<ApprovalId>(requested[1]!), 'decline');

    expect((await second).verdict).toBe('deny');
    expect(requested).toHaveLength(2);
  });

  it('does not reuse an approval whose action already ran', async () => {
    const { trust, approvals, requested } = await setup();
    const first = trust.decide(payment, check());
    await until(() => requested.length === 1);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'approve');
    await first;
    await approvals.finish(asId<ApprovalId>(requested[0]!), true);

    const second = trust.decide(payment, check());
    await until(() => requested.length === 2);
    await approvals.resolve(asId<ApprovalId>(requested[1]!), 'decline');

    expect((await second).verdict).toBe('deny');
    expect(requested).toHaveLength(2);
  });

  it('keeps a decline for the rest of the turn', async () => {
    const { trust, approvals, requested } = await setup();
    const first = trust.decide(payment, check());
    await until(() => requested.length === 1);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'decline');
    await first;

    const second = await trust.decide(payment, check());

    expect(second).toMatchObject({ verdict: 'deny' });
    expect(second.reason).toMatch(/earlier in the turn/);
    expect(requested).toHaveLength(1);
  });
});

describe('TrustService: background work (#51)', () => {
  it('expires an unanswered card instead of waiting forever on a background turn', async () => {
    const { trust, requested, repos } = await setup({ backgroundWaitMs: 20 });

    const decision = await trust.decide(payment, { ...check(), background: true });

    expect(decision).toMatchObject({ verdict: 'deny' });
    expect(decision.reason).toMatch(/expired/);
    expect((await repos.approvals.get(asId<ApprovalId>(requested[0]!)))!.status).toBe('expired');
  });
});
