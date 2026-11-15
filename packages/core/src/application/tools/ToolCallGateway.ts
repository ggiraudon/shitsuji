import { z } from 'zod/v4';
import { BaseTool, type ToolOutput } from '../../ports/Tool.js';

export const TOOL_CALL = 'tool_call';

export const toolCallInput = z.object({
  name: z.string().min(1).describe('The tool to call, as tool_search named it'),
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
  readonly name = TOOL_CALL;
  readonly description =
    'Call a tool found with tool_search by its name, with arguments matching the schema it returned.';
  readonly input = toolCallInput;
  readonly effect = 'read' as const; // the real tool's effect is checked after unwrapping

  async run(): Promise<ToolOutput> {
    throw new Error('tool_call is handled by the tool pipeline and never runs itself');
  }
}
