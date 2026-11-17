/**
 * In-process notifications (UI updates, metrics, proactivity signals). Not durable: anything that must
 * survive a crash is written to the database first, then published.
 */

import type { OutboundFile } from './Tool.js';

/** Every event and its payload. Add new events here so publishers and subscribers are type-checked. */
export interface ShitsujiEvents {
  'session.created': { sessionId: string; agentId: string };
  'session.updated': { sessionId: string; action: string; key?: string; value?: string };
  'session.ended': { sessionId: string };
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
  /** A turn was queued, started, or ended. `reply` is set when it succeeded. */
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
    status: 'approved' | 'declined' | 'expired' | 'executed' | 'uncertain';
  };
}

export type EventName = keyof ShitsujiEvents;

export interface EventMeta {
  /** Who published it, e.g. "agent" or "telegram". */
  source?: string;
  /** Correlates events that belong to one turn or request. */
  traceId?: string;
}

export interface PublishedEvent<K extends EventName = EventName> {
  type: K;
  payload: ShitsujiEvents[K];
  meta: EventMeta;
  at: Date;
}

export type Handler<T> = (payload: T, event: PublishedEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

/** A prefix pattern such as "tool.*" (matches tool.called, tool.result, …) or "*" for everything. */
export type EventPattern = `${string}.*` | '*';

export interface EventBus {
  publish<K extends EventName>(type: K, payload: ShitsujiEvents[K], meta?: EventMeta): void;
  subscribe<K extends EventName>(type: K, handler: Handler<ShitsujiEvents[K]>): Unsubscribe;
  subscribePattern(pattern: EventPattern, handler: Handler<unknown>): Unsubscribe;
}
