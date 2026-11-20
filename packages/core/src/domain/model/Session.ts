import type { SessionId, ThreadId } from './ids.js';

/**
 * What a session is for. Limits and context differ per kind (F04, F15). Two things depend on it: the
 * per-turn model-call limit (`DEFAULT_STEP_LIMITS`: `chat` 40, `task` 200, `helper` 30, `schedule`
 * 40, `observer` 20) and the SOUL's session-kind fragments. Only `chat` is created today; the others
 * are for tasks, background checks and scheduled runs.
 */
export type SessionKind = 'chat' | 'task' | 'helper' | 'schedule' | 'observer';

/** The same kinds as a runtime list, so code can iterate them; keep it in step with {@link SessionKind}. */
export const SESSION_KINDS: readonly SessionKind[] = [
  'chat',
  'task',
  'helper',
  'schedule',
  'observer',
];

/**
 * One line of work inside a thread: the main chat, a background task, a scheduled run… A session runs
 * one turn at a time; sessions run in parallel. Its messages are stored separately, so a `/new`
 * conversation starts clean without touching the thread's history.
 *
 * Created by `MessageIntake.startSession` (via `Agent.startSession`) and read back by the
 * repositories; the fields are plain data, not a state machine.
 */
export class Session {
  constructor(
    readonly id: SessionId,
    readonly threadId: ThreadId,
    /** Decides the step limit and the session-kind SOUL fragments. */
    readonly kind: SessionKind,
    readonly createdAt: Date,
    /**
     * A rolling summary of older messages, once the transcript is compacted (F04). The messages
     * themselves stay in storage; the summary replaces them only in the model's context.
     */
    public summary?: string,
    /**
     * How many of the session's oldest messages that summary covers. Kept with the summary so a
     * compaction never has to count the transcript again.
     */
    public summaryCount = 0,
  ) {}
}
