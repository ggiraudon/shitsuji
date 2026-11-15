/**
 * In-process notifications (UI updates, metrics, proactivity signals). Not durable: anything that must
 * survive a crash is written to the database first, then published.
 */

/** Every event and its payload. Add new events here so publishers and subscribers are type-checked. */
export interface ShitsujiEvents {
  'system.ready': { version: string };
  'system.error': { error: Record<string, unknown>; event?: string };
  'session.created': { sessionId: string; agentId: string };
  'session.updated': { sessionId: string; action: string; key?: string };
  'session.ended': { sessionId: string };
  'message.received': { sessionId: string; role: string; content: string };
  'message.sent': { sessionId: string; role: string; content?: string; isError?: boolean };
  'llm.request': { agentId: string; sessionId: string; model?: string };
  'llm.response': {
    agentId: string;
    sessionId: string;
    contentLength: number;
    hasToolCalls: boolean;
  };
  'llm.error': { agentId: string; sessionId: string; error: string };
  'tool.called': { sessionId: string; toolName: string; toolCallId: string };
  'tool.result': { sessionId: string; toolName: string; toolCallId: string; success: boolean };
  'tool.error': { sessionId: string; toolName: string; toolCallId: string; error: string };
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
