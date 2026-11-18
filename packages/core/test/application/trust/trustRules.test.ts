import { describe, expect, it } from 'vitest';
import { InMemoryRepositories } from '../../../src/adapters/memory/InMemoryRepositories.js';
import { actionRequest } from '../../../src/application/trust/ActionRequest.js';
import { ApprovalService } from '../../../src/application/trust/ApprovalService.js';
import type { Authority } from '../../../src/application/trust/Authority.js';
import { PolicyEngine } from '../../../src/application/trust/PolicyEngine.js';
import type { StandingRule } from '../../../src/application/trust/StandingRule.js';
import { TrustJudge } from '../../../src/application/trust/TrustJudge.js';
import { TrustService } from '../../../src/application/trust/TrustService.js';
import type { TrustCheck } from '../../../src/application/trust/TrustPolicy.js';
import { asId, type ApprovalId, type OwnerId } from '../../../src/domain/model/ids.js';
import { ScriptedProvider, routerFor, testServices, until } from '../../helpers.js';

const check = (): TrustCheck => ({
  turnId: 'turn-1',
  sessionId: 'session-1',
  signal: new AbortController().signal,
});

const mail = actionRequest({
  tool: 'mail.send',
  arguments: { to: 'anna@example.com' },
  effect: 'external',
  target: 'core',
});

const payment = actionRequest({
  tool: 'shop.pay',
  arguments: { amount: '10 EUR' },
  effect: 'payment',
  target: 'core',
});

function setup(rules: StandingRule[]) {
  const repos = new InMemoryRepositories();
  const services = testServices();
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events: services.events,
    clock: services.clock,
    log: services.log,
  });
  const provider = new ScriptedProvider([], 'fake');
  const authority: Authority = { words: ['Email Anna the report.'], rules: [] };
  const trust = new TrustService({
    engine: new PolicyEngine({ rules }),
    authority: { forTurn: async () => authority },
    judge: new TrustJudge({ models: routerFor(provider), log: services.log }),
    approvals,
    ownerId: asId<OwnerId>('owner'),
    log: services.log,
  });
  const requested: string[] = [];
  services.events.subscribe('approval.requested', (e) => {
    requested.push(e.approvalId);
  });
  return { trust, approvals, requested, provider };
}

describe('configurable standing rules (#58, F11)', () => {
  it('asks because of a rule even when the judge could allow, without calling the judge', async () => {
    const { trust, approvals, requested, provider } = setup([
      { action: 'ask', tool: 'mail.*', detail: 'always ask before emailing' },
    ]);

    const deciding = trust.decide(mail, check());
    await until(() => requested.length === 1);

    expect(provider.requests).toHaveLength(0);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'approve');
    expect((await deciding).verdict).toBe('allow');
  });

  it('refuses because of a rule without calling the judge', async () => {
    const { trust, requested, provider } = setup([
      { action: 'deny', tool: 'mail.send', detail: 'never email anyone' },
    ]);

    const decision = await trust.decide(mail, check());

    expect(decision).toMatchObject({ verdict: 'deny' });
    expect(decision.reason).toMatch(/never email anyone/);
    expect(provider.requests).toHaveLength(0);
    expect(requested).toHaveLength(0);
  });

  it('lets a go-ahead rule allow an outside action, and names it in the basis', async () => {
    const { trust, requested, provider } = setup([
      { action: 'allow', tool: 'mail.send', detail: 'go ahead with the report email' },
    ]);

    const decision = await trust.decide(mail, check());

    expect(decision).toMatchObject({
      verdict: 'allow',
      basis: { kind: 'rule', detail: 'go ahead with the report email' },
    });
    expect(provider.requests).toHaveLength(0);
    expect(requested).toHaveLength(0);
  });

  it('never lets an allow rule unlock a payment', async () => {
    const { trust, approvals, requested, provider } = setup([
      { action: 'allow', tool: 'shop.pay', detail: 'go ahead with payments' },
    ]);

    const deciding = trust.decide(payment, check());
    await until(() => requested.length === 1);

    expect(provider.requests).toHaveLength(0);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'decline');
    expect((await deciding).verdict).toBe('deny');
  });

  it('asks before a workspace command, the natural use of a rule (#62)', async () => {
    const { trust, approvals, requested, provider } = setup([
      { action: 'ask', tool: 'workspace.exec', detail: 'always ask before running commands' },
    ]);
    const exec = actionRequest({
      tool: 'workspace.exec',
      arguments: { command: 'npm test' },
      effect: 'write_local',
      target: 'workspace',
    });

    const deciding = trust.decide(exec, check());
    await until(() => requested.length === 1);

    // A card, not the level's automatic allow, and no judgement spent.
    expect(provider.requests).toHaveLength(0);
    await approvals.resolve(asId<ApprovalId>(requested[0]!), 'approve');
    expect((await deciding).verdict).toBe('allow');
  });

  it('refuses a read a rule forbids (#62)', async () => {
    const { trust, requested } = setup([
      { action: 'deny', tool: 'files.read', detail: 'never read my notes' },
    ]);
    const read = actionRequest({
      tool: 'files.read',
      arguments: { path: 'notes.md' },
      effect: 'read',
      target: 'workspace',
    });

    const decision = await trust.decide(read, check());

    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toMatch(/never read my notes/);
    expect(requested).toHaveLength(0);
  });
});
