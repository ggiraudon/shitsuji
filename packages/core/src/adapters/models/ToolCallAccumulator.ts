import { randomUUID } from 'node:crypto';
import type { ToolCallId } from '../../domain/model/ids.js';
import type { ToolCall } from '../../domain/model/Message.js';

/** One streamed piece of a tool call: the index it belongs to, and whatever this chunk carries. */
export interface ToolCallFragment {
  /** The position of the call in the response; id, name and arguments all arrive under it. */
  index: number;
  /** The provider's id for the call, sent once near the start. */
  id?: string;
  /** A piece of the tool name, which some providers split across chunks. */
  name?: string;
  /** A piece of the JSON arguments string. */
  arguments?: string;
}

/** A call under construction: what has arrived so far. */
interface Partial {
  /** The provider's id, when it sent one. */
  id?: string;
  /** The name, concatenated from its fragments. */
  name: string;
  /** The argument JSON, concatenated from its fragments. */
  args: string;
}

/** A call whose arguments never became a JSON object; the provider turns this into a `ProviderError`. */
export class ToolCallArgumentsError extends Error {
  /** The class name, for logs. */
  override readonly name = 'ToolCallArgumentsError';
}

/**
 * Assembles streamed tool calls. Providers send a call's id and name once and its JSON arguments in
 * many fragments, keyed by index; a call is only usable when the stream ends (bug 3 in
 * docs/00-current-state.md parsed each fragment on its own).
 */
export class ToolCallAccumulator {
  /** The calls by provider index, in arrival order. */
  private readonly calls = new Map<number, Partial>();

  /** Folds one fragment into its call, creating it on first sight. */
  add(fragment: ToolCallFragment): void {
    let call = this.calls.get(fragment.index);
    if (!call) this.calls.set(fragment.index, (call = { name: '', args: '' }));
    if (fragment.id) call.id = fragment.id;
    if (fragment.name) call.name += fragment.name;
    if (fragment.arguments) call.args += fragment.arguments;
  }

  /** How many calls have started, for a progress hint in logs. */
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
