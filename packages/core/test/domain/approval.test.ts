import { describe, expect, it } from 'vitest';
import { Approval, type ApprovalStatus } from '../../src/domain/model/Approval.js';
import { InvalidTransition } from '../../src/domain/errors.js';
import {
  asId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../src/domain/model/ids.js';

const at = new Date('2026-11-17T10:00:00Z');

const pending = () =>
  Approval.request({
    id: asId<ApprovalId>('a1'),
    ownerId: asId<OwnerId>('owner'),
    turnId: asId<TurnId>('turn-1'),
    sessionId: asId<SessionId>('session-1'),
    tool: 'test.notify',
    effect: 'external',
    target: 'core',
    actionHash: 'a'.repeat(64),
    arguments: { text: 'Hello' },
    summary: 'test.notify (external)',
    createdAt: at,
  });

const statusAfter = (steps: (a: Approval) => void): ApprovalStatus => {
  const approval = pending();
  steps(approval);
  return approval.status;
};

describe('Approval (S36, F11)', () => {
  it('starts pending and open, with the exact action bound to it', () => {
    const approval = pending();

    expect(approval.status).toBe('pending');
    expect(approval.isOpen).toBe(true);
    expect(approval.actionHash).toBe('a'.repeat(64));
    expect(approval.toProps()).toMatchObject({
      tool: 'test.notify',
      effect: 'external',
      arguments: { text: 'Hello' },
    });
  });

  it('goes pending -> approved -> executed, and stamps the times', () => {
    const approval = pending();
    approval.approve(at);
    expect(approval.isOpen).toBe(true);
    approval.execute(new Date('2026-11-17T10:01:00Z'));

    expect(approval.status).toBe('executed');
    expect(approval.isOpen).toBe(false);
    expect(approval.toProps()).toMatchObject({
      decidedAt: at,
      endedAt: new Date('2026-11-17T10:01:00Z'),
    });
  });

  it('goes pending -> declined, and pending -> expired', () => {
    expect(statusAfter((a) => a.decline(at))).toBe('declined');
    expect(statusAfter((a) => a.expire(at))).toBe('expired');
  });

  it('marks a failed or interrupted run uncertain', () => {
    expect(
      statusAfter((a) => {
        a.approve(at);
        a.uncertain(at);
      }),
    ).toBe('uncertain');
  });

  it('refuses every illegal move', () => {
    const executed = pending();
    executed.approve(at);
    executed.execute(at);
    expect(() => executed.approve(at)).toThrow(InvalidTransition);
    expect(() => executed.execute(at)).toThrow(InvalidTransition);

    const declined = pending();
    declined.decline(at);
    expect(() => declined.approve(at)).toThrow(InvalidTransition);

    expect(() => pending().execute(at)).toThrow(InvalidTransition);
    expect(() => pending().uncertain(at)).toThrow(InvalidTransition);
  });

  it('can only be approved or declined once', () => {
    const approval = pending();
    approval.approve(at);

    expect(() => approval.decline(at)).toThrow(InvalidTransition);
  });
});
