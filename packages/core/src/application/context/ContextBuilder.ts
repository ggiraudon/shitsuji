import type { ContentPart, ImageAttachment, Message } from '../../domain/model/Message.js';
import { textOf, toolCallsOf } from '../../domain/model/Message.js';
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
  /** The injectable that rendered it. */
  id: string;
  /** The text it added, already trimmed of empty renderings. */
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
  /** What went into the system prompt, per injectable, in order. */
  header: RenderedNote[];
  /** The system notes placed before the history, per injectable, in order. */
  context: RenderedNote[];
  /** The text attached to the opening owner message for this turn, when a tail injectable rendered. */
  tail?: string;
}

/** What the builder needs: the injectables, storage, the limits, and the optional parts. */
export interface ContextBuilderDeps {
  /** The live injectables; a function because plugins may add more after the agent is built. */
  injectables: () => readonly ContextInjectable[];
  /** Reads the transcript, the session and the owner. */
  repos: Repositories;
  /** The owner whose profile the render context carries. */
  ownerId: OwnerId;
  /** Structured logger; oversize images and an unstable header are reported here. */
  log: Logger;
  /** The most recent messages sent to the model; the open request is always kept. */
  historyLimit?: number;
  /** How many of the newest images stay pixels; older ones become placeholders (default 3, S52). */
  imageHistoryLimit?: number;
  /** Raw bytes allowed per image; bigger files become a placeholder (default 5 MiB, S52). */
  imageMaxBytes?: number;
  /** Whether the active chat purpose has any model with vision; false means placeholders, no reads. */
  visionAvailable?: boolean;
  /** Loads a stored image reference (workspace-relative) at build time. */
  images?: ImageSource;
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

/** Reads the bytes behind a stored image reference; the sandbox driver supplies it in core. */
export interface ImageSource {
  /** The bytes of a workspace-relative image, or a rejection the builder turns into a placeholder. */
  read(ref: string): Promise<Uint8Array>;
}

type ResolvedImage = { image: ImageAttachment } | { placeholder: string };

const PLACEMENT_RANK: Record<InjectionPlacement, number> = { header: 0, context: 1, tail: 2 };

/**
 * The tail travels on the owner's message, so it says where it comes from: the model must not read
 * the clock as something the owner typed, or repeat it back (#66).
 */
export const TAIL_MARKER = "[Context from Shitsuji, not the owner's words]";

/** 5 MiB of raw bytes; base64 adds a third on top, so this bounds the request too. */
const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Turns a session's transcript plus every `ContextInjectable` into one model call's context (F04).
 * Each injectable declares a placement and an order, so where its text lands is a property of the
 * code, not a convention: the header starts the cached prefix, context notes sit at the start of the
 * history, and the tail changes every call without touching either (decision Q7).
 *
 * **How one request is built**, in order:
 *
 * 1. Read the transcript and re-read the session, because a compaction earlier in the turn may have
 *    moved its summary and watermark. Compact first when the transcript nears the window.
 * 2. Keep at most `historyLimit` messages, extended back to the owner message that opened this turn,
 *    so a long tool loop cannot push the open request out of view.
 * 3. Sort the injectables by placement (`header`, `context`, `tail`), then `order`, then id; evaluate
 *    their conditions and render them. An empty rendering adds nothing.
 * 4. The header becomes `system`, the stable prefix of the request. Context notes become system-role
 *    messages placed before the history. The tail is appended to the turn's opening owner message,
 *    behind {@link TAIL_MARKER}, and is frozen for every step of that turn.
 * 5. Trim the history to whole exchanges (never start on a tool result), drop withdrawn messages and
 *    re-order tool results directly after the call they answer; a call with no result gets a
 *    synthetic error result so the history stays valid.
 * 6. Prune and load images under the S52 rules below, then return the parts.
 *
 * ```mermaid
 * flowchart TD
 *   store[(transcript)] --> compact{over the window?}
 *   compact -- yes --> summary[summarise the covered prefix]
 *   compact -- no --> window
 *   summary --> window[keep historyLimit, back to the open request]
 *   window --> render[render injectables by placement, then order]
 *   render --> header[header]
 *   render --> notes[context notes]
 *   render --> tail[tail, frozen per turn]
 *   window --> order[whole exchanges + tool results reordered]
 *   order --> images[prune images, load the kept ones]
 *   header --> request[["system + notes + history + tail"]]
 *   notes --> request
 *   images --> request
 *   tail --> request
 * ```
 *
 * **The cache split (Q7).** Providers cache a prefix of the request, and anything that changes early
 * invalidates everything after it. So the stable work comes first and the volatile text last: the
 * header changes almost never, the context notes only when a compaction summary changes, and the tail
 * is re-rendered once per turn and frozen for all its steps. `stabilityCheck` warns when a header
 * injectable changes on two consecutive calls, which costs a cache miss per call.
 *
 * **Images (S52).** The transcript stores only `ref`, a workspace path; bytes are never in jsonb.
 * `visionAvailable` is the gate: without a vision model, every image becomes a "cannot be viewed"
 * placeholder and no file is read. With vision, only the newest `imageHistoryLimit` (3) images stay
 * pixels — counted from the end, so the result is deterministic and a re-build is byte-identical —
 * and an image over `imageMaxBytes` (5 MiB) becomes a "too large" placeholder, logged once per file.
 * Kept images are read through {@link ImageSource} and sent as base64 for this request only; a file
 * that cannot be read leaves an "unavailable" placeholder. An image dropped from a tool result is
 * appended to that result's text, so the model still knows it existed.
 */
export class ContextBuilder {
  /** Injectable ids that already rendered once in a session (`once` condition). */
  private readonly renderedOnce = new Map<SessionId, Set<string>>();
  /** The previous header text per session and injectable, for the stability check. */
  private readonly headerSeen = new Map<SessionId, Map<string, HeaderState>>();
  /** The tail of each session's current turn, rendered once so every step of the turn reuses it. */
  private readonly turnTails = new Map<
    SessionId,
    {
      /** The turn the frozen tail belongs to; a new turn renders a fresh one. */
      turnId: Turn['id'];
      /** The tail text, or undefined when no tail injectable rendered for that turn. */
      text: string | undefined;
    }
  >();
  /** Image references already reported as too large, so one bad file logs once. */
  private readonly warnedOversize = new Set<string>();

  constructor(
    /** Storage, the injectables, the limits and the optional compaction and image reader. */
    private readonly deps: ContextBuilderDeps,
  ) {}

  /**
   * Builds one request: compact if needed, window the history, render the injectables by placement,
   * re-order the tool results, prune/load images and attach the turn's frozen tail. Called once per
   * model step, so everything it reads is the state as of that step.
   */
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
    const vision = this.deps.visionAvailable === true;
    const pruned = pruneImages(
      ordered.map((m) => ({ role: m.role, parts: m.parts })),
      vision ? (this.deps.imageHistoryLimit ?? 3) : 0,
      vision ? imagePlaceholder : cannotViewPlaceholder,
    );
    const messages = vision ? await this.loadImages(pruned) : pruned;
    const notes: ModelMessage[] = rendered.context.map((note) => ({
      role: 'system',
      parts: [{ type: 'text', text: note.text }],
    }));
    // The tail is fixed for the turn: re-rendering it on each step would change the opening request
    // between calls and cost a cache miss for the whole tool loop after it.
    const frozen = this.turnTails.get(session.id);
    const renderedTail = rendered.tail.map((n) => n.text).join('\n\n');
    const tail =
      frozen?.turnId === turn.id
        ? frozen.text
        : renderedTail
          ? `${TAIL_MARKER}\n${renderedTail}`
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

  /**
   * Turns stored image references into request images. Bytes never live in the transcript: the
   * reader (the sandbox's files port) supplies them now. A missing file leaves a deterministic
   * placeholder so the model is not shown an empty image.
   */
  private async loadImages(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const out: ModelMessage[] = [];
    for (const message of messages) {
      const parts: ContentPart[] = [];
      for (const part of message.parts) {
        if (part.type === 'image') {
          const resolved = await this.resolveImage(part);
          if (resolved && 'image' in resolved) {
            parts.push({ type: 'image', ...resolved.image });
          } else {
            parts.push({
              type: 'text',
              text: resolved?.placeholder ?? unavailablePlaceholder(part),
            });
          }
          continue;
        }
        if (part.type === 'tool_result' && part.images?.length) {
          const kept: ImageAttachment[] = [];
          const placeholders: string[] = [];
          for (const image of part.images) {
            const resolved = await this.resolveImage(image);
            if (resolved && 'image' in resolved) kept.push(resolved.image);
            else placeholders.push(resolved?.placeholder ?? unavailablePlaceholder(image));
          }
          parts.push({
            ...part,
            content: [part.content, ...placeholders].filter(Boolean).join('\n'),
            ...(kept.length && { images: kept }),
          });
          continue;
        }
        parts.push(part);
      }
      out.push({ ...message, parts });
    }
    return out;
  }

  /** Loads and checks one image reference: bytes, a placeholder, or undefined for "unavailable". */
  private async resolveImage(image: ImageAttachment): Promise<ResolvedImage | undefined> {
    if (image.data || image.url) return { image };
    if (!image.ref || !this.deps.images) return undefined;
    try {
      const bytes = await this.deps.images.read(image.ref);
      const maxBytes = this.deps.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
      if (bytes.length > maxBytes) {
        const key = `${image.ref}:${bytes.length}`;
        if (!this.warnedOversize.has(key)) {
          this.warnedOversize.add(key);
          this.deps.log.warn('Image is too large for the context', {
            ref: image.ref,
            bytes: bytes.length,
            maxBytes,
          });
        }
        return { placeholder: tooLargePlaceholder(image, bytes.length) };
      }
      return { image: { ...image, data: Buffer.from(bytes).toString('base64') } };
    } catch (error) {
      this.deps.log.warn('Could not load an image for the context', {
        ref: image.ref,
        error: { message: error instanceof Error ? error.message : 'unknown' },
      });
      return undefined;
    }
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

  /** Records that a `once` injectable has rendered for a session, so it never does again there. */
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
 * Keeps the newest `keep` images as pixels; every older image becomes a one-line placeholder. Counting
 * from the end makes the result deterministic per message, so a re-build keeps the cached prefix
 * byte-identical (Q7). A tool result's images become text appended to its content.
 */
function pruneImages(
  messages: ModelMessage[],
  keep: number,
  placeholder: (image: ImageAttachment) => string = imagePlaceholder,
): ModelMessage[] {
  let remaining = Math.max(0, keep);
  return messages
    .slice()
    .reverse()
    .map((message) => {
      const parts = message.parts
        .slice()
        .reverse()
        .map((part): ContentPart => {
          if (part.type === 'image') {
            if (remaining > 0) {
              remaining -= 1;
              return part;
            }
            return { type: 'text', text: placeholder(part) };
          }
          if (part.type === 'tool_result' && part.images?.length) {
            const kept: ImageAttachment[] = [];
            const dropped: ImageAttachment[] = [];
            for (const image of part.images.slice().reverse()) {
              if (remaining > 0) {
                remaining -= 1;
                kept.unshift(image);
              } else {
                dropped.unshift(image);
              }
            }
            if (!dropped.length) return part;
            const { images: _images, ...rest } = part;
            return {
              ...rest,
              content: [part.content, ...dropped.map(placeholder)].filter(Boolean).join('\n'),
              ...(kept.length ? { images: kept } : {}),
            };
          }
          return part;
        })
        .reverse();
      return { ...message, parts };
    })
    .reverse();
}

const imageLabel = (image: ImageAttachment): string =>
  image.name ?? image.ref?.split(/[\\/]/).pop() ?? image.mediaType;

const imagePlaceholder = (image: ImageAttachment): string =>
  `[image: ${imageLabel(image)}, sent earlier]`;

const cannotViewPlaceholder = (image: ImageAttachment): string =>
  `[image: ${imageLabel(image)}, cannot be viewed with the current model]`;

const tooLargePlaceholder = (image: ImageAttachment, bytes: number): string =>
  `[image: ${imageLabel(image)}, too large to show (${(bytes / 1024 / 1024).toFixed(1)} MB)]`;

const unavailablePlaceholder = (image: ImageAttachment): string =>
  `[image: ${imageLabel(image)}, unavailable]`;

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
