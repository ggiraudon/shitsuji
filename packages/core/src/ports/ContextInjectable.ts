import type { Message, ToolCall } from '../domain/model/Message.js';
import type { Session, SessionKind } from '../domain/model/Session.js';

/**
 * Where an injectable's text goes. Ordered by how often it changes, so the provider's prompt cache
 * keeps matching a prefix: the header changes almost never, context notes on compaction, the tail
 * every call (F04, decision Q7).
 */
export type InjectionPlacement =
  | 'header' // the system prompt; only stable content
  | 'context' // system-role notes inside the history
  | 'tail'; // attached to the newest message for this call only, never stored

export type InjectionConditionType =
  'always' | 'tool_used' | 'pattern_detected' | 'custom' | 'once' | 'session_kind';

export interface InjectionConditionAlways {
  type: 'always';
}

export interface InjectionConditionToolUsed {
  type: 'tool_used';
  toolNames: string[];
}

export interface InjectionConditionPatternDetected {
  type: 'pattern_detected';
  patterns: RegExp[];
}

export interface InjectionConditionCustom {
  type: 'custom';
  check: (context: AgentRenderContext) => boolean;
}

/** Rendered at most once per session (tracked by the ContextBuilder). */
export interface InjectionConditionOnce {
  type: 'once';
}

export interface InjectionConditionSessionKind {
  type: 'session_kind';
  kinds: readonly SessionKind[];
}

export type InjectionCondition =
  | InjectionConditionAlways
  | InjectionConditionToolUsed
  | InjectionConditionPatternDetected
  | InjectionConditionCustom
  | InjectionConditionOnce
  | InjectionConditionSessionKind;

export interface AgentRenderContext {
  session: Session;
  /** The recent messages being sent to the model, oldest first. */
  messages: Message[];
  /** Tool calls in the latest assistant message. */
  toolCalls?: ToolCall[];
  lastUserMessage?: string;
  /** Your profile, for the owner injectable. */
  owner?: {
    displayName: string;
    timezone: string;
    locale: string;
  };
  /** The SOUL revision this turn runs with, fixed at the turn's start. */
  soul?: { revision: number; body: string };
  /** The compaction summary of older messages, when there is one. */
  summary?: string;
  /** How many of the session's oldest messages that summary covers. */
  summaryCount?: number;
}

export interface ContextInjectable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly placement: InjectionPlacement;
  /** Ascending within a placement: -1 comes before 0. */
  readonly order: number;
  readonly condition: InjectionCondition;

  render(context: AgentRenderContext): string | null;
}

export abstract class BaseContextInjectable implements ContextInjectable {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  placement: InjectionPlacement = 'header';
  order = 0;
  condition: InjectionCondition = { type: 'always' };

  abstract render(context: AgentRenderContext): string | null;
}
