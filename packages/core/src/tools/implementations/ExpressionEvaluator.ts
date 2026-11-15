/**
 * Evaluates arithmetic expressions with a small recursive-descent parser. The input is never handed to
 * `eval`/`Function`: only numbers, the operators below, parentheses, and the named functions and
 * constants in the tables can appear.
 *
 * Grammar (lowest to highest precedence):
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/" | "%") unary)*
 *   unary      := ("+" | "-") unary | power
 *   power      := primary (("^" | "**") unary)?       right-associative; -2^2 = -(2^2)
 *   primary    := number | name | name "(" arguments ")" | "(" expression ")"
 */

export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
}

type Token =
  | { kind: 'number'; value: number; text: string }
  | { kind: 'name'; value: string; text: string }
  | { kind: 'op'; value: string; text: string }
  | { kind: 'end'; text: string };

interface MathFunction {
  fn: (...args: number[]) => number;
  minArgs: number;
  maxArgs: number; // Infinity for variadic
}

const unary = (fn: (x: number) => number): MathFunction => ({ fn, minArgs: 1, maxArgs: 1 });
const binary = (fn: (x: number, y: number) => number): MathFunction => ({
  fn,
  minArgs: 2,
  maxArgs: 2,
});
const variadic = (fn: (...xs: number[]) => number): MathFunction => ({
  fn,
  minArgs: 1,
  maxArgs: Infinity,
});

const FUNCTIONS: ReadonlyMap<string, MathFunction> = new Map([
  ['abs', unary(Math.abs)],
  ['sign', unary(Math.sign)],
  ['sqrt', unary(Math.sqrt)],
  ['cbrt', unary(Math.cbrt)],
  ['exp', unary(Math.exp)],
  ['ln', unary(Math.log)],
  ['log', unary(Math.log)],
  ['log10', unary(Math.log10)],
  ['log2', unary(Math.log2)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['round', unary(Math.round)],
  ['trunc', unary(Math.trunc)],
  ['sin', unary(Math.sin)],
  ['cos', unary(Math.cos)],
  ['tan', unary(Math.tan)],
  ['asin', unary(Math.asin)],
  ['acos', unary(Math.acos)],
  ['atan', unary(Math.atan)],
  ['sinh', unary(Math.sinh)],
  ['cosh', unary(Math.cosh)],
  ['tanh', unary(Math.tanh)],
  ['asinh', unary(Math.asinh)],
  ['acosh', unary(Math.acosh)],
  ['atanh', unary(Math.atanh)],
  ['atan2', binary(Math.atan2)],
  ['pow', binary(Math.pow)],
  ['min', variadic(Math.min)],
  ['max', variadic(Math.max)],
  ['hypot', variadic(Math.hypot)],
]);

const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
  ['tau', 2 * Math.PI],
  ['ln2', Math.LN2],
  ['ln10', Math.LN10],
  ['log2e', Math.LOG2E],
  ['log10e', Math.LOG10E],
  ['sqrt2', Math.SQRT2],
  ['sqrt1_2', Math.SQRT1_2],
]);

const OPERATORS = ['**', '+', '-', '*', '/', '%', '^', '(', ')', ','] as const;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

export class ExpressionEvaluator {
  constructor(private readonly limits = { maxLength: 1000, maxDepth: 100 }) {}

  evaluate(expression: string): number {
    if (expression.length > this.limits.maxLength) {
      throw new ExpressionError(
        `Expression is too long (${expression.length} characters, limit ${this.limits.maxLength})`,
      );
    }
    const parser = new Parser(tokenize(expression), this.limits.maxDepth);
    const result = parser.parse();
    if (!Number.isFinite(result)) {
      throw new ExpressionError(`Result is not a finite number (${result})`);
    }
    return result;
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      const text = number[0];
      const next = input[i + text.length];
      if (next !== undefined && /[\d.]/.test(next)) {
        const bad = /^[\d.eE+-]+/.exec(rest)?.[0] ?? text;
        throw new ExpressionError(`Invalid number "${bad}"`);
      }
      tokens.push({ kind: 'number', value: Number(text), text });
      i += text.length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: 'name', value: name[0].toLowerCase(), text: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ kind: 'op', value: op === '**' ? '^' : op, text: op });
      i += op.length;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${input[i]}" at position ${i + 1}`);
  }
  if (tokens.length === 0) throw new ExpressionError('Expression is empty');
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly maxDepth: number,
  ) {}

  parse(): number {
    const value = this.expression();
    const extra = this.peek();
    if (extra.kind !== 'end') throw this.unexpected(extra);
    return value;
  }

  private expression(): number {
    this.enter();
    let value = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().text;
      const right = this.term();
      value = op === '+' ? value + right : value - right;
    }
    this.depth--;
    return value;
  }

  private term(): number {
    let value = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().text;
      const right = this.unary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  private unary(): number {
    if (this.isOp('+') || this.isOp('-')) {
      this.enter();
      const negative = this.next().text === '-';
      const value = this.unary();
      this.depth--;
      return negative ? -value : value;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.isOp('^')) {
      this.next();
      this.enter();
      const exponent = this.unary();
      this.depth--;
      return Math.pow(base, exponent);
    }
    return base;
  }

  private primary(): number {
    const token = this.next();
    if (token.kind === 'number') return token.value;
    if (token.kind === 'op' && token.value === '(') {
      const value = this.expression();
      this.expect(')');
      return value;
    }
    if (token.kind === 'name') {
      if (this.isOp('(')) return this.call(token);
      const constant = CONSTANTS.get(token.value);
      if (constant !== undefined) return constant;
      if (FUNCTIONS.has(token.value)) {
        throw new ExpressionError(`Function "${token.text}" needs arguments in parentheses`);
      }
      throw new ExpressionError(`Unknown name "${token.text}"`);
    }
    throw this.unexpected(token);
  }

  private call(name: Extract<Token, { kind: 'name' }>): number {
    const fn = FUNCTIONS.get(name.value);
    if (!fn) throw new ExpressionError(`Unknown function "${name.text}"`);
    this.expect('(');
    const args: number[] = [];
    if (!this.isOp(')')) {
      args.push(this.expression());
      while (this.isOp(',')) {
        this.next();
        args.push(this.expression());
      }
    }
    this.expect(')');
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      throw new ExpressionError(arityMessage(name.text, fn, args.length));
    }
    return fn.fn(...args);
  }

  private enter(): void {
    if (++this.depth > this.maxDepth) {
      throw new ExpressionError(`Expression is too deeply nested (limit ${this.maxDepth})`);
    }
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.pos++;
    return token;
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.value === op;
  }

  private expect(op: string): void {
    if (!this.isOp(op)) {
      const token = this.peek();
      throw new ExpressionError(
        token.kind === 'end'
          ? `Expected "${op}" but the expression ended`
          : `Expected "${op}" but found "${token.text}"`,
      );
    }
    this.next();
  }

  private unexpected(token: Token): ExpressionError {
    return new ExpressionError(
      token.kind === 'end' ? 'Unexpected end of expression' : `Unexpected "${token.text}"`,
    );
  }
}

function arityMessage(name: string, fn: MathFunction, got: number): string {
  if (fn.maxArgs === Infinity) {
    return `Function "${name}" needs at least ${fn.minArgs} argument${fn.minArgs === 1 ? '' : 's'}`;
  }
  const n = fn.minArgs;
  return `Function "${name}" takes ${n} argument${n === 1 ? '' : 's'}, got ${got}`;
}
