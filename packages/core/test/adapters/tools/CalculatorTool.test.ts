import { describe, expect, it } from 'vitest';
import { CalculatorTool } from '../../../src/adapters/tools/CalculatorTool.js';

const run = (expression: unknown) =>
  new CalculatorTool().execute({ sessionId: 'test', args: { expression } });

const value = async (expression: string) => {
  const result = await run(expression);
  expect(result, `"${expression}" should succeed`).toMatchObject({ success: true });
  return Number(result.result);
};

const failure = async (expression: string) => {
  const result = await run(expression);
  expect(result, `"${expression}" should fail`).toMatchObject({ success: false, result: '' });
  return result.error ?? '';
};

describe('CalculatorTool', () => {
  it('describes itself with a required string expression', () => {
    const tool = new CalculatorTool();
    expect(tool.name).toBe('calculator');
    expect(tool.schema).toMatchObject({ required: ['expression'] });
  });

  it('rejects a non-string expression without throwing', async () => {
    await expect(run(42)).resolves.toEqual({
      success: false,
      result: '',
      error: 'Expression must be a string',
    });
  });

  describe('arithmetic', () => {
    it.each([
      ['2 + 2', 4],
      ['10 * 5', 50],
      ['7 - 10', -3],
      ['1 / 4', 0.25],
      ['10 % 4', 2],
      ['(1 + 2) * 3', 9],
      ['1 + 2 * 3', 7],
      ['2 * (3 + 4) - 5 / (1 + 1)', 11.5],
      ['  12  ', 12],
      ['.5 + 1.25', 1.75],
      ['1e3 + 2.5E-1', 1000.25],
    ])('%s = %d', async (expression, expected) => {
      expect(await value(expression)).toBe(expected);
    });
  });

  describe('powers and signs', () => {
    it.each([
      ['2 ^ 10', 1024],
      ['2 ** 3', 8],
      ['2 ^ 3 ^ 2', 512], // right-associative
      ['-2 ^ 2', -4], // power binds tighter than unary minus, as in maths
      ['(-2) ^ 2', 4],
      ['-3 + 5', 2],
      ['--3', 3],
      ['+4', 4],
      ['2 * -3', -6],
      ['2 ^ -1', 0.5],
      ['0.1 + 0.2', 0.3], // floating-point noise is rounded away
    ])('%s = %d', async (expression, expected) => {
      expect(await value(expression)).toBe(expected);
    });
  });

  describe('functions and constants', () => {
    it.each([
      ['sqrt(16)', 4],
      ['abs(-7.5)', 7.5],
      ['max(1, 9, 3)', 9],
      ['min(4, -2)', -2],
      ['pow(2, 5)', 32],
      ['round(2.5) + floor(1.9) + ceil(1.1) + trunc(-1.7)', 5],
      ['log10(1000)', 3],
      ['log2(8)', 3],
      ['hypot(3, 4)', 5],
      ['2 * sqrt(abs(-9))', 6],
      ['SQRT(16)', 4], // names are case-insensitive
    ])('%s = %d', async (expression, expected) => {
      expect(await value(expression)).toBe(expected);
    });

    it.each([
      ['PI', Math.PI],
      ['pi', Math.PI],
      ['E', Math.E],
      ['2 * pi', 2 * Math.PI],
      ['sin(pi / 2)', 1],
      ['cos(0)', 1],
      ['log(e)', 1],
    ])('%s ≈ %d', async (expression, expected) => {
      expect(await value(expression)).toBeCloseTo(expected, 12);
    });
  });

  describe('errors', () => {
    it.each([
      ['', /empty/i],
      ['2 +', /unexpected end/i],
      ['(1 + 2', /expected "\)"/i],
      ['1 + 2)', /unexpected "\)"/i],
      ['2 3', /unexpected "3"/i],
      ['foo(1)', /unknown function "foo"/i],
      ['x + 1', /unknown name "x"/i],
      ['sqrt', /needs arguments/i],
      ['sqrt(1, 2)', /takes 1 argument/i],
      ['max()', /at least 1 argument/i],
      ['1 / 0', /not a finite number/i],
      ['sqrt(-1)', /not a finite number/i],
      ['1.2.3', /invalid number/i],
      ['2 $ 3', /unexpected character "\$"/i],
    ])('%j fails with %s', async (expression, message) => {
      const error = await failure(expression);
      expect(error).toMatch(/^Calculation error: /);
      expect(error).toMatch(message);
    });

    it('never runs JavaScript from the expression', async () => {
      (globalThis as { pwned?: boolean }).pwned = false;
      for (const attack of [
        'globalThis.pwned = true',
        'constructor.constructor("globalThis.pwned = true")()',
        '(() => { globalThis.pwned = true })()',
        'this',
      ]) {
        await failure(attack);
      }
      expect((globalThis as { pwned?: boolean }).pwned).toBe(false);
    });

    it('rejects very long input', async () => {
      expect(await failure('1+'.repeat(600) + '1')).toMatch(/too long/i);
    });

    it('rejects very deep nesting', async () => {
      expect(await failure('('.repeat(150) + '1' + ')'.repeat(150))).toMatch(/too deeply nested/i);
      expect(await failure('-'.repeat(500) + '1')).toMatch(/too deeply nested/i);
    });
  });
});
