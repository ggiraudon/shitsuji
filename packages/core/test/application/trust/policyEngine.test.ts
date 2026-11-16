import { describe, expect, it } from 'vitest';
import { actionRequest } from '../../../src/application/trust/ActionRequest.js';
import {
  DEFAULT_APPROVAL_LEVEL,
  PolicyEngine,
  type ApprovalLevel,
} from '../../../src/application/trust/PolicyEngine.js';
import type { ToolEffect } from '../../../src/ports/Tool.js';

const decide = (effect: ToolEffect, level: ApprovalLevel = DEFAULT_APPROVAL_LEVEL) =>
  new PolicyEngine({ level }).decide(
    actionRequest({ tool: 'test.tool', arguments: { n: 1 }, effect, target: 'core' }),
  );

describe('PolicyEngine: the decision order (S34, F11)', () => {
  it.each<[ToolEffect, ApprovalLevel, string, boolean | undefined]>([
    ['read', 'ask', 'allow', undefined],
    ['read', 'auto-edits', 'allow', undefined],
    ['compute', 'trusted', 'allow', undefined],
    ['write_local', 'ask', 'ask', undefined],
    ['write_local', 'auto-edits', 'allow', undefined],
    ['write_local', 'trusted', 'allow', undefined],
    ['write_self', 'ask', 'ask', undefined],
    ['write_self', 'auto-edits', 'judge', true],
    ['write_self', 'trusted', 'judge', false],
    ['external', 'ask', 'ask', undefined],
    ['external', 'auto-edits', 'judge', true],
    ['external', 'trusted', 'judge', true],
    ['payment', 'ask', 'ask', undefined],
    ['payment', 'auto-edits', 'ask', undefined],
    ['payment', 'trusted', 'ask', undefined],
  ])('%s at the %s level decides %s', (effect, level, verdict, quoteRequired) => {
    const decision = decide(effect, level);

    expect(decision.verdict).toBe(verdict);
    expect(decision.quoteRequired).toBe(quoteRequired);
  });

  it('allows reading and computing by policy, naming the effect', () => {
    expect(decide('read').basis).toEqual({
      kind: 'policy',
      detail: 'read actions need no approval',
    });
    expect(decide('compute')).toMatchObject({
      verdict: 'allow',
      basis: { kind: 'policy', detail: 'compute actions need no approval' },
    });
  });

  it('allows workspace changes by the level, and names the level that allowed them', () => {
    expect(decide('write_local', 'auto-edits')).toMatchObject({
      verdict: 'allow',
      basis: { kind: 'policy', detail: 'the approval level (auto-edits) allows workspace changes' },
    });
    expect(decide('write_local', 'trusted').basis.detail).toMatch(/trusted/);
  });

  it('asks for workspace changes at the ask level, and for money at every level', () => {
    expect(decide('write_local', 'ask')).toMatchObject({
      verdict: 'ask',
      basis: { kind: 'none' },
    });
    expect(decide('write_local', 'ask').reason).toMatch(/workspace/);

    for (const level of ['ask', 'auto-edits', 'trusted'] as const) {
      expect(decide('payment', level)).toMatchObject({ verdict: 'ask', basis: { kind: 'none' } });
      expect(decide('payment', level).reason).toMatch(/money/);
    }
  });

  it('asks directly at the ask level, without spending a judgement', () => {
    expect(decide('external', 'ask')).toMatchObject({ verdict: 'ask', basis: { kind: 'none' } });
    expect(decide('write_self', 'ask').reason).toMatch(/outside the workspace/);
  });

  it('sends outside actions and self-changes to the judge, and carries the action hash', () => {
    const action = actionRequest({
      tool: 'mail.send',
      arguments: { to: 'anna@example.com' },
      effect: 'external',
      target: 'core',
    });

    const decision = new PolicyEngine().decide(action);

    expect(decision).toMatchObject({ verdict: 'judge', basis: { kind: 'none' } });
    expect(decision.actionHash).toBe(action.hash);
    expect(action.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
