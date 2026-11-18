import { describe, expect, it } from 'vitest';
import { actionRequest } from '../../src/application/trust/ActionRequest.js';
import { PolicyEngine } from '../../src/application/trust/PolicyEngine.js';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { trustRulesOf } from '../../src/composition/createShitsuji.js';

const config = (rules: Record<string, unknown>[]) =>
  shitsujiConfigSchema.parse({
    paths: { dataDir: '/tmp/shitsuji-test' },
    channels: { webhook: { enabled: false } },
    api: { enabled: false },
    models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/test-model' } },
    trust: { rules },
  });

const send = actionRequest({
  tool: 'workspace.send',
  arguments: { path: 'report.pdf' },
  effect: 'external',
  target: 'workspace',
});

const decideFor = (rules: Record<string, unknown>[], action = send) =>
  new PolicyEngine({ rules: trustRulesOf(config(rules)) }).decide(action);

describe('the shipped trust rules are merged with the config (X4)', () => {
  it('still allows workspace.send when the config lists an unrelated rule', () => {
    const decision = decideFor([{ tool: 'test.notify', verdict: 'ask' }]);

    expect(decision).toMatchObject({ verdict: 'allow', basis: { kind: 'rule' } });
  });

  it("lets the owner's ask rule for workspace.send override the shipped allow", () => {
    expect(decideFor([{ tool: 'workspace.send', verdict: 'ask' }])).toMatchObject({
      verdict: 'ask',
    });
  });

  it("lets the owner's deny rule for workspace.send win too", () => {
    expect(decideFor([{ tool: 'workspace.send', verdict: 'deny' }])).toMatchObject({
      verdict: 'deny',
    });
  });

  it('still refuses payments and keeps other outside actions on the judge', () => {
    const pay = actionRequest({
      tool: 'shop.pay',
      arguments: { amount: '10 EUR' },
      effect: 'payment',
      target: 'core',
    });
    const mail = actionRequest({
      tool: 'mail.send',
      arguments: { to: 'anna@example.com' },
      effect: 'external',
      target: 'core',
    });

    expect(decideFor([], pay)).toMatchObject({ verdict: 'ask' });
    expect(decideFor([], mail)).toMatchObject({ verdict: 'judge' });
  });
});
