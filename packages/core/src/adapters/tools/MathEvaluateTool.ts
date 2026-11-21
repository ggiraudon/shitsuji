import { z } from 'zod/v4';
import { BaseTool, type ToolOutput } from '../../ports/Tool.js';
import { ExpressionEvaluator } from './ExpressionEvaluator.js';

const input = z.object({
  /** The expression to evaluate, in the grammar `ExpressionEvaluator` documents. */
  expression: z.string().min(1).describe('An arithmetic expression, e.g. "sqrt(16) * pi"'),
});

/** math.evaluate: exact arithmetic so the model never calculates in its head. */
export class MathEvaluateTool extends BaseTool<typeof input> {
  /** The tool's name, `math.evaluate`. */
  readonly name = 'math.evaluate';
  /** What the model reads: the operators, functions and constants it accepts. */
  readonly description =
    'Evaluate an arithmetic expression. Supports + - * / % ^ (power), parentheses, functions ' +
    '(sqrt, abs, round, floor, ceil, min, max, pow, log, ln, log10, log2, exp, sin, cos, tan, ' +
    'hypot, …) and constants (pi, e, tau). Use this for any math instead of calculating yourself.';
  /** The expression schema. */
  readonly input = input;
  /** Pure computation, so no approval is needed. */
  readonly effect = 'compute' as const;
  /** The parser and evaluator, shared by every call. */
  private readonly evaluator = new ExpressionEvaluator();

  /** Evaluates, or returns a calculation error with the parser's message. */
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
