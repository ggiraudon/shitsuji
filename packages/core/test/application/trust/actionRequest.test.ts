import { describe, expect, it } from 'vitest';
import { actionHash, actionRequest } from '../../../src/application/trust/ActionRequest.js';

describe('ActionRequest (S34)', () => {
  it('carries the tool, arguments, effect, target and a hash', () => {
    const action = actionRequest({
      tool: 'mail.send',
      arguments: { to: 'anna@example.com', subject: 'Report' },
      effect: 'external',
      target: 'core',
    });

    expect(action).toMatchObject({
      tool: 'mail.send',
      arguments: { to: 'anna@example.com', subject: 'Report' },
      effect: 'external',
      target: 'core',
    });
    expect(action.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same tool and arguments the same, whatever the key order or nesting', () => {
    const one = actionHash('mail.send', {
      to: 'anna@example.com',
      body: { text: 'hi', cc: ['bob@example.com'] },
    });
    const two = actionHash('mail.send', {
      body: { cc: ['bob@example.com'], text: 'hi' },
      to: 'anna@example.com',
    });

    expect(two).toBe(one);
  });

  it('changes the hash with the tool or any argument, including order inside an array', () => {
    const base = actionHash('mail.send', { to: 'anna', cc: ['a', 'b'] });

    expect(actionHash('mail.draft', { to: 'anna', cc: ['a', 'b'] })).not.toBe(base);
    expect(actionHash('mail.send', { to: 'bob', cc: ['a', 'b'] })).not.toBe(base);
    expect(actionHash('mail.send', { to: 'anna', cc: ['b', 'a'] })).not.toBe(base);
  });

  it('ignores an argument that is undefined, and nothing else', () => {
    expect(actionHash('t', { a: 1, b: undefined })).toBe(actionHash('t', { a: 1 }));
    expect(actionHash('t', { a: null })).not.toBe(actionHash('t', {}));
  });
});
