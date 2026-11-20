import type { Message, ToolCall } from '../domain/model/Message.js';
import type { Session, SessionKind } from '../domain/model/Session.js';

/**
 * Where an injectable's text goes. Ordered by how often it changes, so the provider's prompt cache
 * keeps matching a prefix: the header changes almost never, context notes on compaction, the tail
 * every call (F04, decision Q7). The tail is rendered once per turn and reused for every step of that
 * turn; the header is checked for stability, because a header that changes per call costs a cache miss.
 */
export type InjectionPlacement =
  | 'header' // the system prompt; only stable content
  | 'context' // system-role notes inside the history
  | 'tail'; // attached to the newest message for this call only, never stored

/** The kinds of condition an injectable can carry; see the interfaces below for each one. */
export type InjectionConditionType =
  'always' | 'tool_used' | 'pattern_detected' | 'custom' | 'once' | 'session_kind';

/** Always rendered. */
export interface InjectionConditionAlways {
  type: 'always';
}

/** Rendered when the latest assistant message called one of these tools; an empty list means any tool. */
export interface InjectionConditionToolUsed {
  type: 'tool_used';
  toolNames: string[];
}

/** Rendered when one of the patterns matches the owner's latest message. */
export interface InjectionConditionPatternDetected {
  type: 'pattern_detected';
  patterns: RegExp[];
}

/** Rendered when `check` returns true. It runs on every build, so keep it cheap and side-effect free. */
export interface InjectionConditionCustom {
  type: 'custom';
  check: (context: AgentRenderContext) => boolean;
}

/** Rendered at most once per session (tracked by the ContextBuilder). */
export interface InjectionConditionOnce {
  type: 'once';
}

/** Rendered only for these session kinds. */
export interface InjectionConditionSessionKind {
  type: 'session_kind';
  kinds: readonly SessionKind[];
}

/** One of the conditions above; the builder switches on `type`. */
export type InjectionCondition =
  | InjectionConditionAlways
  | InjectionConditionToolUsed
  | InjectionConditionPatternDetected
  | InjectionConditionCustom
  | InjectionConditionOnce
  | InjectionConditionSessionKind;

/**
 * What an injectable sees when it is rendered: the session, the messages that will be sent, and the
 * derived context (tool calls, the owner message, SOUL, summary). It is a snapshot for this build; an
 * injectable must not write anything or call a model.
 */
export interface AgentRenderContext {
  session: Session;
  /** The recent messages being sent to the model, oldest first. */
  messages: Message[];
  /** Tool calls in the latest assistant message. */
  toolCalls?: ToolCall[];
  /** The owner's latest message, text only; what `pattern_detected` tests. */
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

/**
 * One piece of context, rendered when `ContextBuilder` assembles a request. It sorts by placement, then
 * order, then id, evaluates the condition and joins the text; `render` returns null to add nothing.
 * Injectables are how SOUL, the tool index, rules and memory reach the prompt without the runtime
 * knowing about them.
 */
export interface ContextInjectable {
  /** Stable id, also used by `once` tracking and by the stability check. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly placement: InjectionPlacement;
  /** Ascending within a placement: -1 comes before 0. */
  readonly order: number;
  readonly condition: InjectionCondition;

  /** The text to add, or null for nothing. Keep it stable for the same context so prompt caching holds. */
  render(context: AgentRenderContext): string | null;
}

/**
 * Template for injectables: header placement, order 0 and an `always` condition, so a subclass only
 * supplies its identity and `render`.
 */
export abstract class BaseContextInjectable implements ContextInjectable {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  placement: InjectionPlacement = 'header';
  order = 0;
  condition: InjectionCondition = { type: 'always' };

  abstract render(context: AgentRenderContext): string | null;
}
