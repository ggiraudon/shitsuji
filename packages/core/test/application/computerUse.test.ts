import { describe, expect, it } from 'vitest';
import { ComputerUseInjectable } from '../../src/application/context/ComputerUseInjectable.js';

describe('computer-use prompt section (S56)', () => {
  it('puts the tree first, pixels last, and sends secrets through Take control', () => {
    const text = new ComputerUseInjectable().render();
    expect(text).toContain('desktop.inspect');
    expect(text).toContain('desktop.act');
    expect(text).toContain('computer.act');
    expect(text).toContain('computer.request_takeover');
    expect(text).toContain('Never type a secret the owner did not give you');
    expect(text.indexOf('desktop.inspect')).toBeLessThan(text.indexOf('computer.act'));
  });
});
