import { describe, expect, it } from 'vitest';
import { InMemoryRepositories } from '../../../src/adapters/memory/InMemoryRepositories.js';
import { actionRequest } from '../../../src/application/trust/ActionRequest.js';
import { ApprovalService } from '../../../src/application/trust/ApprovalService.js';
import { NotFound } from '../../../src/domain/errors.js';
import {
  asId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../../src/domain/model/ids.js';
import { testServices } from '../../helpers.js';

const ownerId = asId<OwnerId>('owner');
const turnId = asId<TurnId>('turn-1');
const sessionId = asId<SessionId>('session-1');

const action = actionRequest({
  tool: 'test.notify',
  arguments: { text: 'Hello' },
  effect: 'external',
  target: 'core',
});

async function setup() {
  const repos = new InMemoryRepositories();
  const services = testServices();
  const service = new ApprovalService({
    approvals: repos.approvals,
    events: services.events,
    clock: services.clock,
    log: services.log,
  });
  const requested: string[] = [];
  const resolved: { approvalId: string; status: string }[] = [];
  services.events.subscribe('approval.requested', (e) => {
    requested.push(e.approvalId);
  });
  services.events.subscribe('approval.resolved', (e) => {
    resolved.push({ approvalId: e.approvalId, status: e.status });
  });
  const ask = (signal = new AbortController().signal) =>
    service.request({ ownerId, turnId, sessionId, action, reason: 'the judge asked' }, signal);
  return { repos, service, ask, requested, resolved, services };
}

const until = async (check: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ApprovalService (S36, F11)', () => {
  it('creates a pending approval bound to the action, publishes it, and waits', async () => {
    const { ask, requested, repos, resolved } = await setup();
    const _waiting = ask();

    await until(() => requested.length === 1);
    const id = asId<ApprovalId>(requested[0]!);
    const stored = await repos.approvals.get(id);
    expect(stored!.toProps()).toMatchObject({
      turnId,
      sessionId,
      tool: 'test.notify',
      effect: 'external',
      actionHash: action.hash,
      arguments: { text: 'Hello' },
      reason: 'the judge asked',
      status: 'pending',
    });
    expect(stored!.toProps().summary).toContain('test.notify');
    expect(stored!.status).toBe('pending');
    expect(resolved).toEqual([]);
  });

  it('wakes the waiting turn when the owner approves, and runs once', async () => {
    const { ask, requested, service, resolved, repos } = await setup();
    const waiting = ask();
    await until(() => requested.length === 1);
    const id = asId<ApprovalId>(requested[0]!);

    const [first, second] = await Promise.all([
      service.resolve(id, 'approve'),
      service.resolve(id, 'approve'),
    ]);
    const decided = await waiting;

    expect([first.status, second.status, decided.status]).toEqual([
      'approved',
      'approved',
      'approved',
    ]);
    expect(resolved.filter((r) => r.status === 'approved')).toHaveLength(1);
    expect((await repos.approvals.get(id))!.toProps().decidedAt).toBeDefined();
  });

  it('declines without running anything', async () => {
    const { ask, requested, service } = await setup();
    const waiting = ask();
    await until(() => requested.length === 1);

    await service.resolve(asId<ApprovalId>(requested[0]!), 'decline');

    expect((await waiting).status).toBe('declined');
    expect(await service.resolve(asId<ApprovalId>(requested[0]!), 'approve')).toMatchObject({
      status: 'declined',
    });
  });

  it('expires the approval when the turn stops, and the wait ends', async () => {
    const { ask, requested, repos, resolved } = await setup();
    const controller = new AbortController();
    const waiting = ask(controller.signal);
    await until(() => requested.length === 1);
    const id = asId<ApprovalId>(requested[0]!);

    controller.abort();

    expect((await waiting).status).toBe('expired');
    expect((await repos.approvals.get(id))!.status).toBe('expired');
    expect(resolved).toContainEqual({ approvalId: id, status: 'expired' });
  });

  it('marks an approved action executed once it ran, or uncertain if it failed', async () => {
    const { service, ask, requested, repos } = await setup();
    const first = ask();
    await until(() => requested.length === 1);
    await service.resolve(asId<ApprovalId>(requested[0]!), 'approve');
    await first;

    expect(await service.finish(asId<ApprovalId>(requested[0]!), true)).toMatchObject({
      status: 'executed',
    });

    const second = ask();
    await until(() => requested.length === 2);
    await service.resolve(asId<ApprovalId>(requested[1]!), 'approve');
    await second;
    expect(await service.finish(asId<ApprovalId>(requested[1]!), false)).toMatchObject({
      status: 'uncertain',
    });
    expect((await repos.approvals.get(asId<ApprovalId>(requested[1]!)))!.status).toBe('uncertain');
  });

  it('reports an unknown approval', async () => {
    const { service } = await setup();
    await expect(service.resolve(asId<ApprovalId>('missing'), 'approve')).rejects.toThrow(NotFound);
  });
});
