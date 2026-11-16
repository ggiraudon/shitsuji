import { describe, expect, it } from 'vitest';
import {
  ruleMatches,
  strongestRule,
  type StandingRule,
} from '../../../src/application/trust/StandingRule.js';

const rule = (over: Partial<StandingRule> = {}): StandingRule => ({
  action: 'ask',
  tool: 'mail.send',
  ...over,
});

describe('StandingRule (S34)', () => {
  it('matches the exact tool name', () => {
    expect(ruleMatches(rule(), { tool: 'mail.send', target: 'core' })).toBe(true);
    expect(ruleMatches(rule(), { tool: 'mail.draft', target: 'core' })).toBe(false);
  });

  it('matches a glob, and escapes the rest of the name', () => {
    expect(ruleMatches(rule({ tool: 'mail.*' }), { tool: 'mail.send', target: 'core' })).toBe(true);
    expect(ruleMatches(rule({ tool: '*.send' }), { tool: 'mail.send', target: 'core' })).toBe(true);
    expect(ruleMatches(rule({ tool: 'mail.sen?' }), { tool: 'mail.send', target: 'core' })).toBe(
      true,
    );
    expect(ruleMatches(rule({ tool: 'mail.send' }), { tool: 'mailXsend', target: 'core' })).toBe(
      false,
    );
  });

  it('can be limited to one target', () => {
    const toWorkspace = rule({ target: 'workspace' });

    expect(ruleMatches(toWorkspace, { tool: 'mail.send', target: 'workspace' })).toBe(true);
    expect(ruleMatches(toWorkspace, { tool: 'mail.send', target: 'core' })).toBe(false);
  });

  it('lets "never" beat "always ask", which beats "go ahead"', () => {
    const subject = { tool: 'mail.send', target: 'core' } as const;
    const allow = rule({ action: 'allow', detail: 'go ahead' });
    const ask = rule({ action: 'ask', detail: 'always ask before emailing' });
    const deny = rule({ action: 'deny', detail: 'never email clients' });

    expect(strongestRule([allow], subject)).toBe(allow);
    expect(strongestRule([allow, ask], subject)).toBe(ask);
    expect(strongestRule([ask, allow], subject)).toBe(ask);
    expect(strongestRule([allow, ask, deny], subject)).toBe(deny);
    expect(strongestRule([rule({ tool: 'other.*' })], subject)).toBeUndefined();
    expect(strongestRule([], subject)).toBeUndefined();
  });
});
