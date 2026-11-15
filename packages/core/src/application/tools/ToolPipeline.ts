import type { ToolCall } from '../../domain/model/Message.js';
import type { Tool, ToolContext, ToolEffect, ToolOutcome } from '../../ports/Tool.js';
import { TOOL_CALL, toolCallInput } from './ToolCallGateway.js';

/** One call travelling through the pipeline. Middlewares fill in `args` and `effect` as they learn them. */
export interface ToolInvocation {
  call: ToolCall;
  tool: Tool;
  ctx: ToolContext;
  /** Validated arguments (set by ValidationMiddleware). */
  args?: unknown;
  /** The effect of this call with these arguments (set by ValidationMiddleware). */
  effect?: ToolEffect;
}

/** Chain of responsibility: each middleware may answer itself or pass the call on with next(). */
export interface ToolMiddleware {
  readonly name: string;
  handle(invocation: ToolInvocation, next: () => Promise<ToolOutcome>): Promise<ToolOutcome>;
}

/** Finds tools by name. The ToolCatalog (S19) implements it. */
export interface ToolLookup {
  get(name: string): Tool | undefined;
}

/**
 * Runs a tool call through the middlewares, outermost first. Post-processing middlewares (output
 * limit, redaction, wrapping) sit just outside Execute so they see its result on the way back.
 */
export class ToolPipeline {
  constructor(
    private readonly tools: ToolLookup,
    private readonly middlewares: readonly ToolMiddleware[],
  ) {}

  async execute(original: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    // tool_call is a gateway: run the tool it names, so everything below applies to the real tool.
    let call = original;
    if (call.name === TOOL_CALL) {
      const parsed = toolCallInput.safeParse(call.arguments);
      if (!parsed.success) {
        const problems = parsed.error.issues.map(
          (i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`,
        );
        return {
          kind: 'error',
          reason: 'invalid_input',
          content: `Invalid arguments for tool_call: ${problems.join('; ')}`,
        };
      }
      if (parsed.data.name === TOOL_CALL) {
        return { kind: 'error', reason: 'invalid_input', content: 'tool_call cannot call itself' };
      }
      call = { id: call.id, name: parsed.data.name, arguments: parsed.data.arguments };
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        kind: 'error',
        reason: 'not_found',
        content: `There is no tool named "${call.name}". Use tool_search to find one.`,
      };
    }
    const invocation: ToolInvocation = { call, tool, ctx };
    const dispatch = (i: number): Promise<ToolOutcome> => {
      const middleware = this.middlewares[i];
      if (!middleware) {
        throw new Error('The tool pipeline has no ExecuteMiddleware at its end');
      }
      return middleware.handle(invocation, () => dispatch(i + 1));
    };
    return dispatch(0);
  }
}

/** The text the model sees for an outcome. */
export function outcomeText(outcome: ToolOutcome): string {
  return outcome.kind === 'ok' ? outcome.content : `Error (${outcome.reason}): ${outcome.content}`;
}
