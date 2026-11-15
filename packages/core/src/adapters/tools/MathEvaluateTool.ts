import { z } from 'zod/v4';
import { BaseTool, type ToolOutput } from '../../ports/Tool.js';
import { ExpressionEvaluator } from './ExpressionEvaluator.js';

const input = z.object({
  expression: z.string().min(1).describe('An arithmetic expression, e.g. "sqrt(16) * pi"'),
});

/** math.evaluate: exact arithmetic so the model never calculates in its head. */
export class MathEvaluateTool extends BaseTool<typeof input> {
  readonly name = 'math.evaluate';
  readonly description =
    'Evaluate an arithmetic expression. Supports + - * / % ^ (power), parentheses, functions ' +
    '(sqrt, abs, round, floor, ceil, min, max, pow, log, ln, log10, log2, exp, sin, cos, tan, ' +
    'hypot, …) and constants (pi, e, tau). Use this for any math instead of calculating yourself.';
  readonly input = input;
  readonly effect = 'compute' as const;
  private readonly evaluator = new ExpressionEvaluator();

  async run({ expression }: z.infer<typeof input>): Promise<ToolOutput> {
    try {
      const result = this.evaluator.evaluate(expression);
      // 15 significant digits hides binary floating-point noise (0.1 + 0.2 → 0.3).
      return { content: String(Number(result.toPrecision(15))) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Calculation error: ${message}`, isError: true };
    }
  }
}
