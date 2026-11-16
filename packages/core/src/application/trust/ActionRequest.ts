import { createHash } from 'node:crypto';
import type { ToolEffect, ToolTarget } from '../../ports/Tool.js';

/**
 * The exact action a trust decision is about (F11, S34): the tool, the validated arguments, the effect
 * and the target, plus a hash that an approval is bound to. An approval for one hash never covers a
 * different call, even with the same tool name (decision order, F11).
 */
export interface ActionRequest {
  tool: string;
  /** Validated arguments, as the tool's `run()` receives them. */
  arguments: Record<string, unknown>;
  effect: ToolEffect;
  target: ToolTarget;
  /** SHA-256 over the tool and its canonical arguments; stable across key order. */
  hash: string;
}

/** Builds the command from a validated tool call. */
export function actionRequest(input: {
  tool: string;
  arguments: Record<string, unknown>;
  effect: ToolEffect;
  target: ToolTarget;
}): ActionRequest {
  return { ...input, hash: actionHash(input.tool, input.arguments) };
}

/** The hash of an action: the same tool and arguments always give the same value. */
export function actionHash(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson({ tool, arguments: args }))
    .digest('hex');
}

/**
 * JSON with object keys sorted and `undefined` omitted, so two equivalent calls hash the same. Arrays
 * keep their order, because it changes what the tool does.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = canonical(source[key]);
    }
    return sorted;
  }
  return value;
}
