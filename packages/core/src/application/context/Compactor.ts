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
  summary: string;
  count: number;
}

export interface CompactorDeps {
  models: ModelRouter;
  sessions: SessionRepository;
  clock: Clock;
  log: Logger;
  /** Compact when the visible transcript passes this fraction of the context window. */
  threshold?: number;
  /** Most characters of transcript sent to the summarize model. */
  maxInputChars?: number;
  /** Most tokens the summary may take. */
  maxSummaryTokens?: number;
}

const CHARACTERS_PER_TOKEN = 4;

/**
 * Keeps a long conversation inside the model's window: when the visible transcript nears the window,
 * it summarises the messages *older than the open request* into the session's rolling summary and
 * advances its watermark. The full transcript stays stored, and the open request is never summarised
 * away (F04 criterion 5, S23).
 */
export class Compactor {
  private readonly threshold: number;
  private readonly maxInputChars: number;
  private readonly maxSummaryTokens: number;

  constructor(private readonly deps: CompactorDeps) {
    this.threshold = deps.threshold ?? 0.75;
    this.maxInputChars = deps.maxInputChars ?? 24_000;
    this.maxSummaryTokens = deps.maxSummaryTokens ?? 600;
  }

  /** Whether the messages that would be sent need summarising to fit the window. */
  needsCompaction(messages: readonly Message[], contextWindow: number): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    return estimateTokens(messages) > contextWindow * this.threshold;
  }

  /**
   * Summarises the session's older messages (skipping those already covered by the summary) and
   * stores the result. `transcript` must be the session's full messages, oldest first.
   */
  async compactIfNeeded(
    session: Session,
    turn: Turn,
    transcript: readonly Message[],
    contextWindow: number,
    signal?: AbortSignal,
  ): Promise<Compaction | undefined> {
    const covered = Math.min(session.summaryCount ?? 0, transcript.length);
    if (!this.needsCompaction(transcript.slice(covered), contextWindow)) return undefined;

    // The open request and everything after it stay: only what came before this turn is summarised.
    const open = transcript.findIndex((m) => m.turnId === turn.id);
    const end = open === -1 ? transcript.length : open;
    if (end <= covered) return undefined;
    const older = transcript.slice(covered, end).filter((m) => !m.withdrawn);
    if (!older.length) return undefined;

    const prompt = summarisePrompt(session.summary, renderTranscript(older, this.maxInputChars));
    try {
      const { response } = await this.deps.models.complete(
        'summarize',
        {
          messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
          temperature: 0.2,
          maxOutputTokens: this.maxSummaryTokens,
          metadata: { turnId: turn.id },
        },
        { signal },
      );
      const summary = response.text.trim();
      if (!summary) return undefined;
      await this.deps.sessions.setSummary(session.id, summary, end);
      this.deps.log.info('Compacted the transcript', {
        sessionId: session.id,
        summarisedMessages: older.length,
        summaryCount: end,
      });
      return { summary, count: end };
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

function renderTranscript(messages: readonly Message[], maxChars: number): string {
  const lines = messages.map((m) => {
    const who = m.author === 'owner' ? 'Owner' : m.author === 'assistant' ? 'Shitsuji' : 'System';
    const text =
      textOf(m) ||
      m.parts
        .filter((p): p is Extract<typeof p, { type: 'tool_result' }> => p.type === 'tool_result')
        .map((p) => p.content)
        .join('\n');
    return `${who}: ${text}`;
  });
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
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
