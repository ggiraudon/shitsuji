import type { SessionId, ThreadId } from './ids.js';

/** What a session is for. Limits and context differ per kind (F04, F15). */
export type SessionKind = 'chat' | 'task' | 'helper' | 'schedule' | 'observer';

export const SESSION_KINDS: readonly SessionKind[] = [
  'chat',
  'task',
  'helper',
  'schedule',
  'observer',
];

/**
 * One line of work inside a thread: the main chat, a background task, a scheduled run… A session runs
 * one turn at a time; sessions run in parallel. Its messages are stored separately.
 */
export class Session {
  constructor(
    readonly id: SessionId,
    readonly threadId: ThreadId,
    readonly kind: SessionKind,
    readonly createdAt: Date,
    /** A rolling summary of older messages, once the transcript is compacted (F04). */
    public summary?: string,
  ) {}
}
