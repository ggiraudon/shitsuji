import { BaseTool, type ToolResult, type ToolExecuteParams } from '../../ports/LegacyTool.js';
import { ExpressionEvaluator } from './ExpressionEvaluator.js';

export class CalculatorTool extends BaseTool {
  readonly name = 'calculator';
  readonly description =
    'Evaluate an arithmetic expression. Supports + - * / % ^ (power), parentheses, functions ' +
    '(sqrt, abs, round, floor, ceil, min, max, pow, log, ln, log10, log2, exp, sin, cos, tan, ' +
    'hypot, …) and constants (pi, e, tau). Use this for any math instead of calculating yourself.';
  readonly schema = {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          'The mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)", "10 * 5")',
      },
    },
    required: ['expression'],
  };

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { expression } = params.args;

    if (typeof expression !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Expression must be a string',
      };
    }

    try {
      const result = this.evaluator.evaluate(expression);
      // 15 significant digits hides binary floating-point noise (0.1 + 0.2 → 0.3).
      return { success: true, result: String(Number(result.toPrecision(15))) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, result: '', error: `Calculation error: ${message}` };
    }
  }

  private readonly evaluator = new ExpressionEvaluator();
}
