import { randomUUID } from 'node:crypto';
import type { ToolCallId } from '../../domain/model/ids.js';
import type { ToolCall } from '../../domain/model/Message.js';
import type { ToolSpec } from '../../ports/ModelProvider.js';

/**
 * For models without native tool calling ("json-in-text" quirk): the system prompt asks for a fenced
 * JSON block, and this finds it in the reply. Only names of offered tools are accepted.
 */
export class TextToolCallParser {
  /** Instructions appended to the system prompt so the model knows the format. */
  static instructions(tools: readonly ToolSpec[]): string {
    const list = tools
      .map(
        (t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`,
      )
      .join('\n');
    return [
      'You can call tools. To call one, reply with exactly one fenced block and nothing after it:',
      '```tool_call',
      '{"name": "<tool name>", "arguments": { ... }}',
      '```',
      'After the tool result arrives, continue. Available tools:',
      list,
    ].join('\n');
  }

  constructor(
    /** The tools offered with the request; only their names are accepted from the reply. */
    private readonly tools: readonly ToolSpec[],
  ) {}

  /** Splits a reply into its text (without the blocks) and the tool calls it contains. */
  parse(reply: string): {
    /** The reply with the accepted tool-call blocks removed and trimmed. */
    text: string;
    /** The calls found, in order; a block that is not a valid call stays in the text. */
    calls: ToolCall[];
  } {
    const calls: ToolCall[] = [];
    const block = /```(?:tool_call|json)\s*\n([\s\S]*?)\n?```/g;
    const text = reply.replace(block, (whole, body: string) => {
      const call = this.toCall(body);
      if (!call) return whole; // not a tool call: leave it in the text
      calls.push(call);
      return '';
    });
    return { text: text.trim(), calls };
  }

  /** Reads one block's JSON into a call, accepting `name`/`tool` and `arguments`/`args` spellings. */
  private toCall(body: string): ToolCall | undefined {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as { name?: unknown; tool?: unknown; arguments?: unknown; args?: unknown };
    const name =
      typeof v.name === 'string' ? v.name : typeof v.tool === 'string' ? v.tool : undefined;
    if (!name || !this.tools.some((t) => t.name === name)) return undefined;
    const args = v.arguments ?? v.args ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
    return {
      id: `call_${randomUUID()}` as ToolCallId,
      name,
      arguments: args as Record<string, unknown>,
    };
  }
}
