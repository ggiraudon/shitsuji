import { BaseTool, type ToolResult, type ToolExecuteParams } from '../base.js';

export class CalculatorTool extends BaseTool {
  readonly name = 'calculator';
  readonly description = 'Perform mathematical calculations. Use this for any math operations.';
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
      const safeEval = this.createSafeEvaluator();
      const result = safeEval(expression);

      return {
        success: true,
        result: String(result),
      };
    } catch (error) {
      return {
        success: false,
        result: '',
        error: `Calculation error: ${String(error)}`,
      };
    }
  }

  private createSafeEvaluator(): (expr: string) => number {
    const mathConstants: Record<string, number> = {
      E: Math.E,
      LN10: Math.LN10,
      LN2: Math.LN2,
      LOG10E: Math.LOG10E,
      LOG2E: Math.LOG2E,
      PI: Math.PI,
      SQRT1_2: Math.SQRT1_2,
      SQRT2: Math.SQRT2,
    };

    return (expr: string) => {
      const sanitized = expr.replace(/[^0-9+\-*/().eE%^\s]/g, '');
      const funcNames = Object.keys(mathConstants).join(',');
      const funcBody = `
        const ${funcNames} = this;
        const { abs, acos, acosh, asin, asinh, atan, atanh, atan2, 
          ceil, cos, cosh, exp, floor, log, log10, log2, max, min, 
          pow, random, round, sign, sin, sinh, sqrt, tan, tanh, trunc } = Math;
        return ${sanitized};
      `;
      const fn = new Function(funcBody).bind(mathConstants);
      return fn();
    };
  }
}
