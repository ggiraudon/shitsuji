import { z } from 'zod/v4';
import type { EventBus } from './EventBus.js';
import type { Logger } from './Logger.js';
import type { ToolSpec } from './ModelProvider.js';
import type { Transaction } from './Repositories.js';

/**
 * What a tool does, so the pipeline (and later the trust service, F11) can decide how careful to be.
 * Ordered from harmless to most consequential.
 */
export type ToolEffect =
  | 'read' // reads state, changes nothing (search, read a file)
  | 'compute' // pure computation (calculator)
  | 'write_local' // changes the agent's own workspace or desktop
  | 'write_self' // changes Shitsuji's own state (memory, schedules, settings)
  | 'external' // acts on the outside world (send an email, post, submit a form)
  | 'payment'; // spends money

export const TOOL_EFFECTS: readonly ToolEffect[] = [
  'read',
  'compute',
  'write_local',
  'write_self',
  'external',
  'payment',
];

/** Where the tool runs. Only `core` exists until the workspace and desktop containers (F08, F10). */
export type ToolTarget = 'core' | 'workspace' | 'desktop' | 'mcp';

/** How a tool call was allowed, for receipts and the activity log (F22, F11). */
export interface TrustBasis {
  /** `policy` is the fixed rule (S16), `rule` a standing rule, `quote` the owner's words (F11). */
  kind: 'policy' | 'rule' | 'quote' | 'owner' | 'none';
  detail?: string;
}

/** What the trust policy decided about one call. */
export interface TrustDecision {
  allow: boolean;
  basis: TrustBasis;
  /** Why it was refused, when it was. */
  reason?: string;
}

/** What a running tool may use, and nothing else. */
export interface ToolContext {
  turnId: string;
  sessionId: string;
  /** Aborted on Stop. Long-running tools must listen to it. */
  signal: AbortSignal;
  log: Logger;
  events: EventBus;
  /** Runs fn in a transaction only while the turn is still running (TurnLock, F02). */
  writeFenced<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** What a tool's run() returns. `content` is what the model sees. */
export interface ToolOutput {
  content: string;
  /** The tool ran, but did not do what was asked (e.g. a command exited non-zero). */
  isError?: boolean;
  /** Structured result for receipts and UIs; not sent to the model. */
  data?: Record<string, unknown>;
}

/** The result of a call after the pipeline: what the model is told. */
export type ToolOutcome =
  | { kind: 'ok'; content: string; data?: Record<string, unknown> }
  | {
      kind: 'error';
      reason:
        | 'invalid_input'
        | 'not_found'
        | 'denied'
        | 'cancelled'
        | 'failed'
        | 'tool_error'
        | 'repeated_failure';
      content: string;
      data?: Record<string, unknown>;
    };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds tools of any input type
export interface Tool<I = any> {
  /** Dotted, e.g. "workspace.exec". Adapters map dots for providers that refuse them. */
  readonly name: string;
  /** The call contract, short. */
  readonly description: string;
  /** Validates the model's arguments; its JSON Schema is what the model sees. */
  readonly input: z.ZodType;
  readonly effect: ToolEffect | ((args: I) => ToolEffect);
  readonly target: ToolTarget;
  /** Hidden from the prompt until found with tool_search (F05). */
  readonly deferred: boolean;
  /** Output comes from outside (web, email, browser) and is wrapped as untrusted data. */
  readonly untrustedOutput: boolean;
  run(args: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** Template for tools: sensible defaults; subclasses give name, description, input, effect and run. */
export abstract class BaseTool<S extends z.ZodType> implements Tool<z.infer<S>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly input: S;
  abstract readonly effect: ToolEffect | ((args: z.infer<S>) => ToolEffect);
  readonly target: ToolTarget = 'core';
  readonly deferred: boolean = false;
  readonly untrustedOutput: boolean = false;
  abstract run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** The effect of a call with these (already validated) arguments. */
export function effectOf<I>(tool: Tool<I>, args: I): ToolEffect {
  return typeof tool.effect === 'function' ? tool.effect(args) : tool.effect;
}

/** The tool as the model sees it: name, description and a JSON Schema of its arguments. */
export function toolSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: schema };
}
