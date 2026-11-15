import { describe, expect, it } from 'vitest';
import { CalculatorTool } from '../../src/tools/implementations/CalculatorTool.js';

const run = (expression: unknown) =>
  new CalculatorTool().execute({ sessionId: 'test', args: { expression } });

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

  it('reports evaluation errors as a failed result, not an exception', async () => {
    const result = await run('2 +');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Calculation error: /);
  });

  // Known bug 14 in docs/00-current-state.md: the generated function is a syntax error, so every
  // expression fails. `it.fails` passes while the bug exists; remove `.fails` when F05 fixes it.
  it.fails('evaluates basic arithmetic', async () => {
    await expect(run('(1 + 2) * 3')).resolves.toEqual({ success: true, result: '9' });
  });
});
