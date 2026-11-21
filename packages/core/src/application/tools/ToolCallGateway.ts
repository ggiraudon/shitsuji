import { z } from 'zod/v4';
import { BaseTool, type ToolOutput } from '../../ports/Tool.js';

/** The gateway tool's name; the pipeline unwraps it before any middleware sees the call. */
export const TOOL_CALL = 'tool_call';

/** The gateway's arguments: the tool to call and its arguments, validated by the pipeline. */
export const toolCallInput = z.object({
  /** The tool to call, as tool_search named it. */
  name: z.string().min(1).describe('The tool to call, as tool_search named it'),
  /** The arguments, matching the schema tool_search returned. */
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('The arguments, matching the schema tool_search returned'),
});

/**
 * tool_call: calls any tool by name, including tools that are not in this request's tool list. It keeps
 * the request's tool list fixed for a whole session (so the provider's prompt cache stays valid) no
 * matter how many tools exist. The pipeline unwraps it, so validation, trust and receipts apply to the
 * real tool; this class only gives the model the schema.
 */
export class ToolCallGateway extends BaseTool<typeof toolCallInput> {
  /** The gateway's name, `tool_call`. */
  readonly name = TOOL_CALL;
  /** What the model reads to know it can reach any tool through this one. */
  readonly description =
    'Call a tool found with tool_search by its name, with arguments matching the schema it returned.';
  /** The gateway's schema: a tool name and its arguments. */
  readonly input = toolCallInput;
  /** Always `read`: the pipeline checks the real tool's effect after unwrapping. */
  readonly effect = 'read' as const; // the real tool's effect is checked after unwrapping

  /** Never runs: the pipeline resolves the real tool before this step is reached. */
  async run(): Promise<ToolOutput> {
    throw new Error('tool_call is handled by the tool pipeline and never runs itself');
  }
}
