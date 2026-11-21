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
  /** A session was created. */
  'session.created': {
    /** The new session. */
    sessionId: string;
    /** The agent whose runtime created it, as `AgentOptions.name`. */
    agentId: string;
  };
  /** Reserved: a session setting changed. No publisher yet. */
  'session.updated': {
    /** The session that changed. */
    sessionId: string;
    /** What happened, e.g. `summary`. */
    action: string;
    /** The setting's name, when the action changes one value. */
    key?: string;
    /** The new value, for display; never a secret. */
    value?: string;
  };
  /** Reserved: a session ended. No publisher yet. */
  'session.ended': {
    /** The session that ended. */
    sessionId: string;
  };
  /** An owner message was stored; published before any turn runs. */
  'message.received': {
    /** The session the message was stored in. */
    sessionId: string;
    /** The message's role, `user` today. */
    role: string;
    /** The message text. */
    content: string;
  };
  /** The assistant's final text, for UIs that show a reply as it lands. */
  'message.sent': {
    /** The session the reply belongs to. */
    sessionId: string;
    /** The author, `assistant` today. */
    role: string;
    /** The text; absent when the turn attached only files. */
    content?: string;
    /** True when the text reports a failure. */
    isError?: boolean;
  };
  /** The graph finished starting: recovery, the queue, the agent and the channels are up. */
  'system.ready': {
    /** The build version, as `/status` reports it. */
    version: string;
  };
  /** A handler or background step failed; the bus publishes this when a subscriber throws. */
  'system.error': {
    /** The serialised error; see `serializeError`. */
    error: Record<string, unknown>;
    /** The event whose handler failed, when that is what failed. */
    event?: string;
  };
  /** A model request is about to be sent. */
  'llm.request': {
    /** The agent making the call. */
    agentId: string;
    /** The session the call belongs to. */
    sessionId: string;
    /** The model ref the router picked, e.g. `deepseek/deepseek-chat`. */
    model?: string;
  };
  /** A model request returned. */
  'llm.response': {
    /** The agent that made the call. */
    agentId: string;
    /** The session the call belongs to. */
    sessionId: string;
    /** The reply's text length, for a rough progress display. */
    contentLength: number;
    /** Whether the reply asks for tools, so the UI can keep its "working" state on. */
    hasToolCalls: boolean;
  };
  /** A model request failed. */
  'llm.error': {
    /** The agent that made the call. */
    agentId: string;
    /** The session the call belongs to. */
    sessionId: string;
    /** The failure as text, for the report; the stored row has the details. */
    error: string;
  };
  /**
   * A turn was queued, started, or ended. `reply` is set when it succeeded and `question` when it is
   * waiting; `replyChannel` is present when the turn has a chat to answer (the TUI has none).
   */
  'turn.status': {
    /** The turn that changed. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** The status it moved to. */
    status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
    /** The final text, when the status is `succeeded`. */
    reply?: string;
    /** The question a waiting turn asks, e.g. past the check-in limit (S28). */
    question?: string;
    /** Files tools attached to this turn's reply (S33). */
    files?: OutboundFile[];
    /** Why it failed or was cancelled; shown through `failureText` when it reaches the owner. */
    error?: string;
    /** Where the reply goes, e.g. `telegram:12345`; absent for work with no chat. */
    replyChannel?: string;
  };
  /** A piece of the reply as the model streams it. */
  'turn.text_delta': {
    /** The turn being streamed. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** The new text since the previous delta. */
    text: string;
  };
  /** An owner message was folded into a running turn instead of starting a new one. */
  'turn.steered': {
    /** The turn that received the message. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
  };
  /** A tool call is about to run. */
  'tool.started': {
    /** The turn that made the call. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** The tool's dotted name. */
    toolName: string;
    /** The model's id for the call, so the result can be paired with it. */
    toolCallId: string;
  };
  /** A tool call ended, successfully or not. */
  'tool.finished': {
    /** The turn that made the call. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** The tool's dotted name. */
    toolName: string;
    /** The id the call was announced with. */
    toolCallId: string;
    /** Whether the tool returned an ordinary result rather than an error. */
    ok: boolean;
    /** Why it failed, when `ok` is false. */
    error?: string;
  };
  /** Short form of `tool.started` without the turn id; kept for the TUI's tool list. */
  'tool.called': {
    /** The session the call belongs to. */
    sessionId: string;
    /** The tool's dotted name. */
    toolName: string;
    /** The model's id for the call. */
    toolCallId: string;
  };
  /** Short form of `tool.finished`, for a successful call. */
  'tool.result': {
    /** The session the call belongs to. */
    sessionId: string;
    /** The tool's dotted name. */
    toolName: string;
    /** The model's id for the call. */
    toolCallId: string;
    /** Always true; an error is published as `tool.error` instead. */
    success: boolean;
  };
  /** Short form of `tool.finished`, for a failed call. */
  'tool.error': {
    /** The session the call belongs to. */
    sessionId: string;
    /** The tool's dotted name. */
    toolName: string;
    /** The model's id for the call. */
    toolCallId: string;
    /** The failure text the model was shown. */
    error: string;
  };
  /** An action is waiting for the owner (F11, S36). */
  'approval.requested': {
    /** The card's id, which the answer carries back. */
    approvalId: string;
    /** The turn blocked on this answer. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** The tool the action calls. */
    tool: string;
    /** The action's `ToolEffect`, as a string. */
    effect: string;
    /** One line the owner reads before deciding. */
    summary: string;
    /** Binds the approval to one exact action; shown so an audit can match them. */
    actionHash: string;
  };
  /** An approval was approved, declined, expired, executed or became uncertain. */
  'approval.resolved': {
    /** The card that changed. */
    approvalId: string;
    /** The turn that was waiting. */
    turnId: string;
    /** The session the turn belongs to. */
    sessionId: string;
    /** Where the approval ended up; `pending` never appears here. */
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
  /** The event name, as `subscribe` received it. */
  type: K;
  /** The payload; its shape is the entry of {@link ShitsujiEvents} for `type`. */
  payload: ShitsujiEvents[K];
  /** The publisher's metadata; an empty object when it supplied none. */
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
  /** Hands the event to every matching handler; returns before an async handler finishes. */
  publish<K extends EventName>(type: K, payload: ShitsujiEvents[K], meta?: EventMeta): void;
  /** Subscribes to one event name; the returned function removes the handler. */
  subscribe<K extends EventName>(type: K, handler: Handler<ShitsujiEvents[K]>): Unsubscribe;
  /** Subscribes to every event matching a prefix pattern, e.g. `tool.*`. */
  subscribePattern(pattern: EventPattern, handler: Handler<unknown>): Unsubscribe;
}
