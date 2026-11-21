import { serializeError } from '../../domain/errors.js';
import type { Message } from '../../domain/model/Message.js';
import { textOf } from '../../domain/model/Message.js';
import type { Session } from '../../domain/model/Session.js';
import type { Turn } from '../../domain/model/Turn.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';
import type { SessionRepository } from '../../ports/Repositories.js';
import type { ModelRouter } from '../models/ModelRouter.js';

/** A fresh summary of the older transcript and how many of its messages it covers. */
export interface Compaction {
  /** The rolling summary after folding in the new messages. */
  summary: string;
  /** How many of the session's oldest messages the summary now covers. */
  count: number;
}

/**
 * What the visible transcript must fit: the model's window when the catalogue knows it, and the most
 * messages a model call sends. Going over either one starts a compaction.
 */
export interface CompactionBudget {
  /** The chat model's context window, in tokens. */
  contextWindow?: number;
  /** The most messages a model call may send, from `historyLimit`. */
  maxMessages?: number;
}

/** What the compactor needs: the model router, the session store, the clock and its limits. */
export interface CompactorDeps {
  /** Calls the `summarize` purpose; a failure is logged, never fatal to the turn. */
  models: ModelRouter;
  /** Reads and writes the session's summary and watermark. */
  sessions: SessionRepository;
  /** Injected clock for the summary's timestamp. */
  clock: Clock;
  /** Structured logger; a failed summary is reported here. */
  log: Logger;
  /** Compact when the visible transcript passes this fraction of the context window. */
  threshold?: number;
  /** Most characters of transcript sent to the summarize model in one request. */
  maxInputChars?: number;
  /** Most tokens the summary may take. */
  maxSummaryTokens?: number;
  /** Most summarize requests in one compaction; anything left waits for the next model call. */
  maxRounds?: number;
}

const CHARACTERS_PER_TOKEN = 4;

/**
 * Keeps a long conversation inside the model's window: when the visible transcript nears the window
 * or passes the message limit, it summarises the messages *older than the open request* into the
 * session's rolling summary and advances its watermark. The watermark only moves past messages that
 * a summarize request actually saw, in chunks that fit its input. The full transcript stays stored,
 * and the open request is never summarised away (F04 criterion 5, S23).
 */
export class Compactor {
  /** Fraction of the window that triggers a compaction; 0.75 by default. */
  private readonly threshold: number;
  /** Character budget of one summarize request; 24k by default. */
  private readonly maxInputChars: number;
  /** Output-token budget of the summary; 600 by default. */
  private readonly maxSummaryTokens: number;
  /** How many summarize requests one compaction may make; four by default. */
  private readonly maxRounds: number;

  constructor(
    /** The model router, session store, logger and limit overrides. */
    private readonly deps: CompactorDeps,
  ) {
    this.threshold = deps.threshold ?? 0.75;
    this.maxInputChars = deps.maxInputChars ?? 24_000;
    this.maxSummaryTokens = deps.maxSummaryTokens ?? 600;
    this.maxRounds = deps.maxRounds ?? 4;
  }

  /** Whether the messages that would be sent need summarising to fit the budget. */
  needsCompaction(messages: readonly Message[], budget: CompactionBudget | number): boolean {
    const { maxMessages } = asBudget(budget);
    if (maxMessages && visible(messages).length > maxMessages) return true;
    return this.overWindow(messages, asBudget(budget));
  }

  /**
   * Summarises the session's older messages (skipping those already covered by the summary) and
   * stores the result. `transcript` must be the session's full messages, oldest first. A number is
   * read as the context window.
   */
  async compactIfNeeded(
    session: Session,
    turn: Turn,
    transcript: readonly Message[],
    budget: CompactionBudget | number,
    signal?: AbortSignal,
  ): Promise<Compaction | undefined> {
    const limits = asBudget(budget);
    const covered = Math.min(session.summaryCount ?? 0, transcript.length);
    const uncovered = transcript.slice(covered);
    if (!this.needsCompaction(uncovered, limits)) return undefined;

    // The open request and everything after it stay: only what came before this turn is summarised.
    const open = transcript.findIndex((m) => m.turnId === turn.id);
    let target = open === -1 ? transcript.length : open;
    // Over the message limit only: keep the newest half visible, so compaction does not run every turn.
    if (limits.maxMessages && !this.overWindow(uncovered, limits)) {
      const keepFrom = transcript.length - Math.floor(limits.maxMessages / 2);
      target = Math.min(target, startOfExchange(transcript, keepFrom));
    }
    if (target <= covered) return undefined;

    let summary = session.summary;
    let count = covered;
    for (let round = 0; round < this.maxRounds && count < target; round++) {
      const end = chunkEnd(transcript, count, target, this.maxInputChars);
      const older = visible(transcript.slice(count, end));
      if (older.length) {
        const next = await this.summarise(session, turn, summary, older, signal);
        if (next === undefined) break; // failed or empty: keep what is already done
        summary = next;
      }
      count = end;
    }
    if (count === covered || !summary) return undefined;
    await this.deps.sessions.setSummary(session.id, summary, count);
    this.deps.log.info('Compacted the transcript', {
      sessionId: session.id,
      summarisedMessages: count - covered,
      summaryCount: count,
    });
    return { summary, count };
  }

  /** True when the transcript is over the message limit or past the window threshold. */
  private overWindow(messages: readonly Message[], { contextWindow }: CompactionBudget): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    return estimateTokens(messages) > contextWindow * this.threshold;
  }

  /** One summarize request folding `older` into `previous`; undefined when it failed. */
  private async summarise(
    session: Session,
    turn: Turn,
    previous: string | undefined,
    older: readonly Message[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const prompt = summarisePrompt(previous, renderTranscript(older, this.maxInputChars));
    try {
      const { response } = await this.deps.models.complete(
        'summarize',
        {
          messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
          temperature: 0.2,
          maxOutputTokens: this.maxSummaryTokens,
          metadata: { turnId: turn.id, sessionId: session.id, background: turn.isBackground },
        },
        { signal },
      );
      return response.text.trim() || undefined;
    } catch (error) {
      // A Stop must reach the caller; a failed summary is not a failed turn, and the full transcript
      // is still there, just larger.
      if (signal?.aborted) throw error;
      this.deps.log.warn('Compaction failed; keeping the full transcript for now', {
        sessionId: session.id,
        error: serializeError(error),
      });
      return undefined;
    }
  }
}

function asBudget(budget: CompactionBudget | number): CompactionBudget {
  return typeof budget === 'number' ? { contextWindow: budget } : budget;
}

function visible(messages: readonly Message[]): Message[] {
  return messages.filter((m) => !m.withdrawn);
}

/** The first owner message at or after `index`, so a cut never splits a tool call from its result. */
function startOfExchange(messages: readonly Message[], index: number): number {
  for (let i = Math.max(0, index); i < messages.length; i++) {
    if (messages[i]!.role === 'user') return i;
  }
  return messages.length;
}

/**
 * Where a summarize request starting at `from` ends: as many messages as fit `maxChars`, cut at the
 * start of an exchange when one fits, and always at least one message (a huge one is truncated).
 */
export function chunkEnd(
  messages: readonly Message[],
  from: number,
  to: number,
  maxChars: number,
): number {
  let chars = 0;
  let end = from;
  let boundary = -1;
  for (let i = from; i < to; i++) {
    const size = Math.min(lineOf(messages[i]!).length, maxChars) + 1;
    if (i > from && chars + size > maxChars) break;
    chars += size;
    end = i + 1;
    if (end < to && messages[end]!.role === 'user') boundary = end;
  }
  return end < to && boundary > from ? boundary : end;
}

/** Rough token count: four characters per token is close enough for a threshold. */
function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.withdrawn) continue;
    chars += textOf(message).length;
    for (const part of message.parts) {
      if (part.type === 'tool_result') chars += part.content.length;
    }
  }
  return Math.ceil(chars / CHARACTERS_PER_TOKEN);
}

function lineOf(m: Message): string {
  const who = m.author === 'owner' ? 'Owner' : m.author === 'assistant' ? 'Shitsuji' : 'System';
  const text =
    textOf(m) ||
    m.parts
      .filter((p): p is Extract<typeof p, { type: 'tool_result' }> => p.type === 'tool_result')
      .map((p) => p.content)
      .join('\n');
  return `${who}: ${text}`;
}

/** The chunk as text. Only a single message larger than the whole budget is cut, at its end. */
function renderTranscript(messages: readonly Message[], maxChars: number): string {
  return messages
    .map((m) => {
      const line = lineOf(m);
      return line.length > maxChars ? `${line.slice(0, maxChars)} [cut]` : line;
    })
    .join('\n');
}

function summarisePrompt(previous: string | undefined, transcript: string): string {
  return [
    'You keep the running summary of a long conversation between the owner and Shitsuji, a personal assistant.',
    'Fold the new messages into the existing summary. Keep facts, names, dates, numbers, decisions and',
    'anything still open. Drop small talk. Reply with the summary only, as one block of plain text,',
    'in the third person, at most 200 words.',
    '',
    'Existing summary:',
    previous?.trim() ? previous : '(none)',
    '',
    'New messages:',
    transcript,
  ].join('\n');
}
