import type { Message } from '../../domain/model/Message.js';
import { textOf, toolCallsOf, type ContentPart } from '../../domain/model/Message.js';
import type { OwnerId, SessionId } from '../../domain/model/ids.js';
import type { Session } from '../../domain/model/Session.js';
import type { Turn } from '../../domain/model/Turn.js';
import type {
  AgentRenderContext,
  ContextInjectable,
  InjectionPlacement,
} from '../../ports/ContextInjectable.js';
import type { ModelMessage } from '../../ports/ModelProvider.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories } from '../../ports/Repositories.js';
import type { Compactor } from './Compactor.js';

/** One injectable's text, with the id that produced it (for tests and the stability check). */
export interface RenderedNote {
  id: string;
  text: string;
}

/** What one model call sees: the system prompt, the history with context notes, and the tail. */
export interface BuiltContext {
  /** The header injectables joined, or undefined when none rendered. */
  system?: string;
  /** The history, oldest first, with context notes at its start and the tail on the newest message. */
  messages: ModelMessage[];
  /** The stored messages the request was built from (for steering checks and receipts). */
  sources: Message[];
  header: RenderedNote[];
  context: RenderedNote[];
  tail?: string;
}

export interface ContextBuilderDeps {
  injectables: () => readonly ContextInjectable[];
  repos: Repositories;
  ownerId: OwnerId;
  log: Logger;
  /** The most recent messages sent to the model; the open request is always kept. */
  historyLimit?: number;
  /**
   * Warn when a header injectable changes on every call (development and tests; off elsewhere).
   * A clock or a mood that slipped into the header would break the provider's prompt cache.
   */
  stabilityCheck?: boolean;
  /** Summarises older messages when the transcript nears the window (F04). */
  compactor?: Compactor;
  /** The chat model's context window, when the catalogue knows it. */
  contextWindow?: number;
}

const PLACEMENT_RANK: Record<InjectionPlacement, number> = { header: 0, context: 1, tail: 2 };

/**
 * Turns a session's transcript plus every `ContextInjectable` into one model call's context (F04).
 * Each injectable declares a placement and an order, so where its text lands is a property of the
 * code, not a convention: the header starts the cached prefix, context notes sit at the start of the
 * history, and the tail changes every call without touching either (decision Q7).
 */
export class ContextBuilder {
  /** Injectable ids that already rendered once in a session (`once` condition). */
  private readonly renderedOnce = new Map<SessionId, Set<string>>();
  /** The previous header text per session and injectable, for the stability check. */
  private readonly headerSeen = new Map<SessionId, Map<string, HeaderState>>();
  /** The tail of each session's current turn, rendered once so every step of the turn reuses it. */
  private readonly turnTails = new Map<
    SessionId,
    { turnId: Turn['id']; text: string | undefined }
  >();

  constructor(private readonly deps: ContextBuilderDeps) {}

  async build(
    session: Session,
    turn: Turn,
    soul?: { revision: number; body: string },
    signal?: AbortSignal,
  ): Promise<BuiltContext> {
    const stored = await this.deps.repos.messages.listBySession(session.id);
    // Re-read: a compaction earlier in this turn changed the summary and its watermark.
    const sessionNow = (await this.deps.repos.sessions.get(session.id)) ?? session;
    const owner = await this.deps.repos.owners.get(this.deps.ownerId);

    // Compaction may cover more of the transcript before this call is built; the open request stays.
    let summary = sessionNow.summary;
    let summaryCount = sessionNow.summaryCount ?? 0;
    // Both limits count: without a known window, the message limit alone would otherwise drop older
    // messages from the context without anything summarising them.
    if (this.deps.compactor && (this.deps.contextWindow || this.deps.historyLimit)) {
      const compacted = await this.deps.compactor.compactIfNeeded(
        sessionNow,
        turn,
        stored,
        {
          ...(this.deps.contextWindow && { contextWindow: this.deps.contextWindow }),
          ...(this.deps.historyLimit && { maxMessages: this.deps.historyLimit }),
        },
        signal,
      );
      if (compacted) {
        summary = compacted.summary;
        summaryCount = compacted.count;
      }
    }
    const covered = Math.min(summaryCount, stored.length);
    const sources = windowMessages(stored.slice(covered), this.deps.historyLimit, turn.id);
    const lastAssistant = latestWithRole(sources, 'assistant');
    const lastUser = latestWithRole(sources, 'user');
    const ctx: AgentRenderContext = {
      session: sessionNow,
      messages: sources,
      toolCalls: lastAssistant ? toolCallsOf(lastAssistant) : [],
      ...(lastUser && { lastUserMessage: textOf(lastUser) }),
      ...(owner && { owner }),
      ...(soul && { soul }),
      ...(summary && covered > 0 && { summary, summaryCount: covered }),
    };

    const injectables = [...this.deps.injectables()].sort(
      (a, b) =>
        PLACEMENT_RANK[a.placement] - PLACEMENT_RANK[b.placement] ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
    const rendered: Record<InjectionPlacement, RenderedNote[]> = {
      header: [],
      context: [],
      tail: [],
    };
    for (const injectable of injectables) {
      if (!this.applies(injectable, ctx)) continue;
      const text = injectable.render(ctx);
      if (text === null || text.trim() === '') continue;
      rendered[injectable.placement].push({ id: injectable.id, text });
      if (injectable.condition.type === 'once') this.markRendered(session.id, injectable.id);
    }

    const visible = trimToWholeExchanges(sources).filter((message) => !message.withdrawn);
    const ordered = normaliseToolOrder(visible);
    const messages: ModelMessage[] = ordered.map((m) => ({ role: m.role, parts: m.parts }));
    const notes: ModelMessage[] = rendered.context.map((note) => ({
      role: 'system',
      parts: [{ type: 'text', text: note.text }],
    }));
    // The tail is fixed for the turn: re-rendering it on each step would change the opening request
    // between calls and cost a cache miss for the whole tool loop after it.
    const frozen = this.turnTails.get(session.id);
    const tail =
      frozen?.turnId === turn.id
        ? frozen.text
        : rendered.tail.length
          ? rendered.tail.map((n) => n.text).join('\n\n')
          : undefined;
    remember(this.turnTails, session.id, { turnId: turn.id, text: tail });
    this.checkHeaderStability(session.id, rendered.header);
    const open = openRequestIndex(ordered, turn.id);
    const anchor = open === -1 ? -1 : notes.length + open;

    return {
      ...(rendered.header.length && { system: rendered.header.map((n) => n.text).join('\n\n') }),
      messages: attachTail([...notes, ...messages], tail, anchor),
      sources,
      header: rendered.header,
      context: rendered.context,
      ...(tail && { tail }),
    };
  }

  /** Evaluates an injectable's condition. `once` is tracked per session, by this instance. */
  private applies(injectable: ContextInjectable, ctx: AgentRenderContext): boolean {
    const condition = injectable.condition;
    switch (condition.type) {
      case 'always':
        return true;
      case 'tool_used': {
        const used = (ctx.toolCalls ?? []).map((c) => c.name);
        return condition.toolNames.length === 0
          ? used.length > 0
          : used.some((n) => condition.toolNames.includes(n));
      }
      case 'pattern_detected':
        return (
          !!ctx.lastUserMessage && condition.patterns.some((p) => p.test(ctx.lastUserMessage!))
        );
      case 'custom':
        return condition.check(ctx);
      case 'session_kind':
        return condition.kinds.includes(ctx.session.kind);
      case 'once':
        return !this.renderedOnce.get(ctx.session.id)?.has(injectable.id);
    }
  }

  private markRendered(sessionId: SessionId, injectableId: string): void {
    const seen = this.renderedOnce.get(sessionId) ?? new Set<string>();
    seen.add(injectableId);
    remember(this.renderedOnce, sessionId, seen);
  }

  /**
   * Compares each header injectable with its text in the previous call of the same session and warns
   * once when one keeps changing: it belongs in the tail, or it costs a cache miss per call.
   */
  private checkHeaderStability(sessionId: SessionId, header: RenderedNote[]): void {
    if (this.deps.stabilityCheck === false) return;
    const state = this.headerSeen.get(sessionId) ?? new Map<string, HeaderState>();
    const rendered = new Set(header.map((n) => n.id));
    for (const note of header) {
      const previous = state.get(note.id);
      if (!previous) {
        state.set(note.id, { text: note.text, changes: 0, warned: false });
        continue;
      }
      if (previous.text === note.text) {
        previous.changes = 0;
        previous.warned = false;
        continue;
      }
      previous.text = note.text;
      previous.changes++;
      if (previous.changes >= 2 && !previous.warned) {
        previous.warned = true;
        this.deps.log.warn(
          'A header injectable changes on every call; put it in the tail so the prompt cache lasts',
          { injectable: note.id, sessionId },
        );
      }
    }
    for (const id of state.keys()) if (!rendered.has(id)) state.delete(id);
    remember(this.headerSeen, sessionId, state);
  }
}

/** Most sessions whose per-session state is kept in memory; the least recently used are dropped. */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Sets a session's entry as the most recent and drops the oldest beyond the cap. This state is a
 * cache: losing it (or restarting) only re-renders a `once` note or resets the stability check.
 */
function remember<V>(map: Map<SessionId, V>, key: SessionId, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) map.delete(map.keys().next().value!);
}

/**
 * Where the turn's opening owner message sits among the ordered messages, or -1.
 */
function openRequestIndex(messages: Message[], turnId: Turn['id']): number {
  return messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
}

interface HeaderState {
  text: string;
  /** Consecutive calls in which this injectable rendered different text. */
  changes: number;
  warned: boolean;
}

/**
 * The last `limit` messages, extended back to the message that started the current turn: a long
 * tool loop must never push the owner's open request out of the window (F04).
 */
function windowMessages(
  messages: Message[],
  limit: number | undefined,
  turnId: Turn['id'],
): Message[] {
  if (limit === undefined || messages.length <= limit) return messages;
  let start = messages.length - limit;
  const open = messages.findIndex((m) => m.turnId === turnId);
  if (open !== -1 && open < start) start = open;
  return messages.slice(start);
}

function latestWithRole(messages: Message[], role: Message['role']): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === role) return messages[i];
  }
  return undefined;
}

/** Never start a window with a tool result whose call was cut off (part of bug 2). */
function trimToWholeExchanges(messages: Message[]): Message[] {
  const first = messages.findIndex((m) => m.role === 'user');
  return first === -1 ? messages : messages.slice(first);
}

/**
 * Keeps every tool result directly after the assistant message that made its call (#64). A message
 * steered in while a tool ran is stored before the result, which leaves a `tool_call` not followed by
 * `tool_result`; providers reject that. Interleaved messages move after the results, an orphan result
 * is dropped, and a call with no result (a crash) gets a synthetic error result so the history stays
 * valid.
 */
function normaliseToolOrder(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const calls = message.role === 'assistant' ? toolCallsOf(message) : [];
    if (calls.length === 0) {
      // A tool result with no call before it would be rejected by every provider.
      if (message.role !== 'tool') out.push(message);
      continue;
    }
    out.push(message);
    const wanted = new Set(calls.map((call) => call.id));
    const collected = new Set<string>();
    const results: Message[] = [];
    const between: Message[] = [];
    while (i + 1 < messages.length && messages[i + 1]!.role !== 'assistant') {
      i++;
      const next = messages[i]!;
      if (next.role === 'tool') {
        const matched = next.parts.filter(
          (part): part is Extract<ContentPart, { type: 'tool_result' }> =>
            part.type === 'tool_result' &&
            wanted.has(part.toolCallId) &&
            !collected.has(part.toolCallId),
        );
        if (matched.length) {
          for (const part of matched) collected.add(part.toolCallId);
          results.push({ ...next, parts: matched });
        }
      } else {
        between.push(next);
      }
    }
    out.push(...results);
    for (const call of calls) {
      if (collected.has(call.id)) continue;
      out.push({
        ...message,
        role: 'tool',
        author: 'system',
        parts: [
          {
            type: 'tool_result',
            toolCallId: call.id,
            content:
              'The tool did not finish, so its result is missing (the turn was interrupted).',
            isError: true,
          },
        ],
      });
    }
    out.push(...between);
  }
  return out;
}

/**
 * The tail goes on the turn's opening owner message, for this turn only (never stored), so every step
 * of the turn sends the same prefix and the next turn moves it on. Without an opening message in
 * view, it goes on the newest message, or after a tool result as a short user note.
 */
function attachTail(
  messages: ModelMessage[],
  tail: string | undefined,
  anchor = -1,
): ModelMessage[] {
  if (!tail) return messages;
  const target = anchor >= 0 ? messages[anchor] : undefined;
  if (target?.role === 'user') {
    return messages.map((m, i) =>
      i === anchor ? { ...m, parts: [...m.parts, { type: 'text' as const, text: tail }] } : m,
    );
  }
  const last = messages.at(-1);
  if (last?.role === 'user') {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts, { type: 'text', text: tail }] },
    ];
  }
  return [...messages, { role: 'user', parts: [{ type: 'text', text: tail }] }];
}
