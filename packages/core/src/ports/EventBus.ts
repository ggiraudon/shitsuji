/**
 * In-process notifications (UI updates, metrics, proactivity signals). Not durable: anything that must
 * survive a crash is written to the database first, then published.
 */

import type { OutboundFile } from './Tool.js';

/**
 * Every event and its payload. Add new events here so publishers and subscribers are type-checked.
 *
 * Nothing here is durable: a component that must survive a restart writes to the database first and
 * publishes after. Event names are dotted (`turn.status`) so a prefix subscription (`turn.*`) is
 * possible. The publisher never sees a subscriber's error: the in-process bus logs it and republishes
 * it as `system.error`.
 */
export interface ShitsujiEvents {
  'session.created': { sessionId: string; agentId: string };
  /** Reserved: a session setting changed. No publisher yet. */
  'session.updated': { sessionId: string; action: string; key?: string; value?: string };
  /** Reserved: a session ended. No publisher yet. */
  'session.ended': { sessionId: string };
  /** An owner message was stored; published before any turn runs. */
  'message.received': { sessionId: string; role: string; content: string };
  'message.sent': { sessionId: string; role: string; content?: string; isError?: boolean };
  'system.ready': { version: string };
  'system.error': { error: Record<string, unknown>; event?: string };
  'llm.request': { agentId: string; sessionId: string; model?: string };
  'llm.response': {
    agentId: string;
    sessionId: string;
    contentLength: number;
    hasToolCalls: boolean;
  };
  'llm.error': { agentId: string; sessionId: string; error: string };
  /**
   * A turn was queued, started, or ended. `reply` is set when it succeeded and `question` when it is
   * waiting; `replyChannel` is present when the turn has a chat to answer (the TUI has none).
   */
  'turn.status': {
    turnId: string;
    sessionId: string;
    status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
    reply?: string;
    /** The question a waiting turn asks, e.g. past the check-in limit (S28). */
    question?: string;
    /** Files tools attached to this turn's reply (S33). */
    files?: OutboundFile[];
    error?: string;
    replyChannel?: string;
  };
  /** A piece of the reply as the model streams it. */
  'turn.text_delta': { turnId: string; sessionId: string; text: string };
  /** An owner message was folded into a running turn instead of starting a new one. */
  'turn.steered': { turnId: string; sessionId: string };
  'tool.started': { turnId: string; sessionId: string; toolName: string; toolCallId: string };
  'tool.finished': {
    turnId: string;
    sessionId: string;
    toolName: string;
    toolCallId: string;
    ok: boolean;
    error?: string;
  };
  'tool.called': { sessionId: string; toolName: string; toolCallId: string };
  'tool.result': { sessionId: string; toolName: string; toolCallId: string; success: boolean };
  'tool.error': { sessionId: string; toolName: string; toolCallId: string; error: string };
  /** An action is waiting for the owner (F11, S36). */
  'approval.requested': {
    approvalId: string;
    turnId: string;
    sessionId: string;
    tool: string;
    effect: string;
    summary: string;
    actionHash: string;
  };
  /** An approval was approved, declined, expired, executed or became uncertain. */
  'approval.resolved': {
    approvalId: string;
    turnId: string;
    sessionId: string;
    status: 'approved' | 'declined' | 'expired' | 'executed' | 'uncertain';
  };
}

/** One key of {@link ShitsujiEvents}, used to constrain publishers and subscribers. */
export type EventName = keyof ShitsujiEvents;

/** Who published an event and what it belongs to, for logs and tracing. */
export interface EventMeta {
  /** Who published it, e.g. "agent" or "telegram". */
  source?: string;
  /** Correlates events that belong to one turn or request. */
  traceId?: string;
}

/** What a handler receives: the payload plus the envelope the publisher built. */
export interface PublishedEvent<K extends EventName = EventName> {
  type: K;
  payload: ShitsujiEvents[K];
  meta: EventMeta;
  /** When the bus published it, from the injected clock. */
  at: Date;
}

/** A handler may be async; the bus does not await it, so a slow subscriber never blocks a turn. */
export type Handler<T> = (payload: T, event: PublishedEvent) => void | Promise<void>;
/** Stops a subscription; safe to call twice. */
export type Unsubscribe = () => void;

/** A prefix pattern such as "tool.*" (matches tool.called, tool.result, …) or "*" for everything. */
export type EventPattern = `${string}.*` | '*';

/**
 * In-process publish/subscribe. `publish` is synchronous and returns nothing: it hands the event to
 * each handler in subscription order and does not wait for promises. Handlers must therefore do their
 * I/O without blocking the publisher, and a failure must be handled by the bus, not thrown back at the
 * turn that published.
 */
export interface EventBus {
  publish<K extends EventName>(type: K, payload: ShitsujiEvents[K], meta?: EventMeta): void;
  subscribe<K extends EventName>(type: K, handler: Handler<ShitsujiEvents[K]>): Unsubscribe;
  subscribePattern(pattern: EventPattern, handler: Handler<unknown>): Unsubscribe;
}
