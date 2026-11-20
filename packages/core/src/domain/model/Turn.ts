import { InvalidTransition } from '../errors.js';
import type { SessionId, TurnId } from './ids.js';

/**
 * queued → running → succeeded | waiting | failed | cancelled (docs/features/F04-agent-runtime.md).
 * Every write is a compare-and-set from the status the writer believed the turn had: `queued` for a
 * Stop, `running` for a worker, `waiting` for the owner's answer. A turn that reaches a terminal state
 * never moves again. `waiting` is not terminal: the owner's answer ends it as `succeeded` and the
 * following `resume` turn carries on.
 */
export type TurnStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/**
 * What started the turn. `user` is an owner message, `resume` continues a `waiting` turn, and the
 * remaining kinds are background work with no owner message at all (they get the background budget
 * and must not wait indefinitely for an approval).
 */
export type TurnSource = 'user' | 'task' | 'schedule' | 'event' | 'resume';

const ALLOWED: Record<TurnStatus, readonly TurnStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'waiting', 'failed', 'cancelled'],
  waiting: ['succeeded', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * The statuses after which no transition is allowed. `waiting` is deliberately absent: it still ends
 * as `succeeded` (the owner answered) or `cancelled` (Stop).
 */
export const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = ['succeeded', 'failed', 'cancelled'];

/** A turn as stored: plain data, copied in and out of the entity by {@link Turn.toProps}. */
export interface TurnProps {
  id: TurnId;
  sessionId: SessionId;
  source: TurnSource;
  status: TurnStatus;
  createdAt: Date;
  /** Reserved: the turn that caused this one. Persisted, but nothing sets it yet. */
  parentTurnId?: TurnId;
  /** Do not start before this time (scheduled or delayed turns); the scheduler skips it until then. */
  startAfter?: Date;
  /** Where the reply goes, e.g. "telegram:12345". Absent for work with no chat to answer. */
  replyChannel?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** Why it failed or was cancelled, e.g. "interrupted" or "stopped by owner". */
  error?: string;
  /** The SOUL revision this turn ran with, so history can say what shaped it (Q6). */
  soulRevision?: number;
}

/**
 * One run of the agent in a session. A state machine: illegal transitions throw InvalidTransition, so a
 * bug cannot, say, restart a finished turn. A waiting turn ends when the owner answers (`answered`) or
 * Stop cancels it; the `resume` turn carries the answer onward.
 *
 * The entity only mutates in memory. Storing the result is the repository's job, with a compare-and-set
 * from the status the caller believed the turn had (`TurnRepository.update`), so two workers or two
 * processes can never both move the same turn. Callers are `MessageIntake` (create), `TurnScheduler`
 * (`start` after winning the compare-and-set), `TurnRunner` (succeed, wait, fail, cancel) and
 * `StartupRecovery` (fail with `interrupted`).
 */
export class Turn {
  private constructor(private props: TurnProps) {}

  /**
   * A new `queued` turn. The caller supplies the id, so the same turn can be referenced before it is
   * stored.
   */
  static create(props: Omit<TurnProps, 'status'>): Turn {
    return new Turn({ ...props, status: 'queued' });
  }

  /** Rebuilds a turn from storage, in whatever status it was saved. */
  static restore(props: TurnProps): Turn {
    return new Turn({ ...props });
  }

  /** Whether the state machine allows this move, for callers that want to check before trying. */
  static canTransition(from: TurnStatus, to: TurnStatus): boolean {
    return ALLOWED[from].includes(to);
  }

  get id(): TurnId {
    return this.props.id;
  }
  get sessionId(): SessionId {
    return this.props.sessionId;
  }
  get status(): TurnStatus {
    return this.props.status;
  }
  get source(): TurnSource {
    return this.props.source;
  }
  /** The stored failure or cancellation reason; undefined while the turn has not ended that way. */
  get error(): string | undefined {
    return this.props.error;
  }
  /** Succeeded, failed or cancelled: no further transition is possible. */
  get isTerminal(): boolean {
    return TERMINAL_TURN_STATUSES.includes(this.props.status);
  }

  /** True when no owner message started this turn: tasks, schedules and events (F22). */
  get isBackground(): boolean {
    return this.props.source !== 'user' && this.props.source !== 'resume';
  }

  /** Fixes the SOUL revision for this turn; a revision confirmed later waits for the next turn. */
  useSoul(revision: number): void {
    this.props.soulRevision = revision;
  }

  /**
   * Moves a queued turn to `running` and stamps its start. `TurnScheduler.drain` calls this and then
   * saves with compare-and-set from `queued`; losing that race means another worker already started
   * the turn elsewhere.
   */
  start(at: Date): void {
    this.transition('running');
    this.props.startedAt = at;
  }

  /** The model produced a final answer; the runner stores it with compare-and-set from `running`. */
  succeed(at: Date): void {
    this.transition('succeeded');
    this.props.endedAt = at;
  }

  /**
   * The turn asked the owner a question or needs an approval. It ends here: the question is stored as
   * the reply and the owner's next message starts a fresh `resume` turn rather than reviving this one.
   */
  wait(at: Date): void {
    this.transition('waiting');
    this.props.endedAt = at;
  }

  /**
   * The owner answered a waiting turn. The turn ends here; the `resume` turn that carries the answer
   * continues the session (#30).
   */
  answered(at: Date): void {
    this.transition('succeeded');
    this.props.endedAt = at;
  }

  /**
   * The turn ended without an answer. The message is stored on the row and shown to the owner, so it
   * must be a specific cause, not "something went wrong".
   */
  fail(at: Date, error: string): void {
    this.transition('failed');
    this.props.endedAt = at;
    this.props.error = error;
  }

  /** Ends a queued or running turn on the owner's stop, or when the runner sees its abort signal. */
  cancel(at: Date, reason = 'cancelled'): void {
    this.transition('cancelled');
    this.props.endedAt = at;
    this.props.error = reason;
  }

  /** A plain copy for storage: the entity keeps its own object, so a caller cannot mutate the row. */
  toProps(): TurnProps {
    return { ...this.props };
  }

  /** Throws {@link InvalidTransition} when the move is not in the table above. */
  private transition(to: TurnStatus): void {
    if (!Turn.canTransition(this.props.status, to)) {
      throw new InvalidTransition('Turn', this.props.status, to);
    }
    this.props.status = to;
  }
}
