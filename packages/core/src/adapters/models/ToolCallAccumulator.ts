import { randomUUID } from 'node:crypto';
import type { ToolCallId } from '../../domain/model/ids.js';
import type { ToolCall } from '../../domain/model/Message.js';

export interface ToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  /** A piece of the JSON arguments string. */
  arguments?: string;
}

interface Partial {
  id?: string;
  name: string;
  args: string;
}

export class ToolCallArgumentsError extends Error {
  override readonly name = 'ToolCallArgumentsError';
}

/**
 * Assembles streamed tool calls. Providers send a call's id and name once and its JSON arguments in
 * many fragments, keyed by index; a call is only usable when the stream ends (bug 3 in
 * docs/00-current-state.md parsed each fragment on its own).
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, Partial>();

  add(fragment: ToolCallFragment): void {
    let call = this.calls.get(fragment.index);
    if (!call) this.calls.set(fragment.index, (call = { name: '', args: '' }));
    if (fragment.id) call.id = fragment.id;
    if (fragment.name) call.name += fragment.name;
    if (fragment.arguments) call.args += fragment.arguments;
  }

  get size(): number {
    return this.calls.size;
  }

  /** The finished calls in index order. Throws if a call has no name or its arguments are not JSON. */
  finish(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        if (!c.name) throw new ToolCallArgumentsError(`Tool call ${index} has no name`);
        let args: unknown = {};
        if (c.args.trim()) {
          try {
            args = JSON.parse(c.args);
          } catch {
            throw new ToolCallArgumentsError(
              `Tool call "${c.name}" has arguments that are not valid JSON: ${c.args.slice(0, 200)}`,
            );
          }
        }
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          throw new ToolCallArgumentsError(`Tool call "${c.name}" arguments must be a JSON object`);
        }
        return {
          id: (c.id ?? `call_${randomUUID()}`) as ToolCallId,
          name: c.name,
          arguments: args as Record<string, unknown>,
        };
      });
  }
}
