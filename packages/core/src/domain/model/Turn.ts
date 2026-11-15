import { InvalidTransition } from '../errors.js';
import type { SessionId, TurnId } from './ids.js';

/** queued → running → succeeded | waiting | failed | cancelled (docs/features/F04-agent-runtime.md). */
export type TurnStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** What started the turn. */
export type TurnSource = 'user' | 'task' | 'schedule' | 'event' | 'resume';

const ALLOWED: Record<TurnStatus, readonly TurnStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'waiting', 'failed', 'cancelled'],
  waiting: ['cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface TurnProps {
  id: TurnId;
  sessionId: SessionId;
  source: TurnSource;
  status: TurnStatus;
  createdAt: Date;
  parentTurnId?: TurnId;
  /** Do not start before this time (scheduled or delayed turns). */
  startAfter?: Date;
  /** Where the reply goes, e.g. "telegram:12345". */
  replyChannel?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** Why it failed or was cancelled, e.g. "interrupted". */
  error?: string;
  /** The SOUL revision this turn ran with, so history can say what shaped it (Q6). */
  soulRevision?: number;
}

/**
 * One run of the agent in a session. A state machine: illegal transitions throw InvalidTransition, so a
 * bug cannot, say, restart a finished turn. Waiting turns end there; a new `resume` turn continues.
 */
export class Turn {
  private constructor(private props: TurnProps) {}

  static create(props: Omit<TurnProps, 'status'>): Turn {
    return new Turn({ ...props, status: 'queued' });
  }

  /** Rebuilds a turn from storage, in whatever status it was saved. */
  static restore(props: TurnProps): Turn {
    return new Turn({ ...props });
  }

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
  get error(): string | undefined {
    return this.props.error;
  }
  get isTerminal(): boolean {
    return TERMINAL_TURN_STATUSES.includes(this.props.status);
  }

  /** Fixes the SOUL revision for this turn; a revision confirmed later waits for the next turn. */
  useSoul(revision: number): void {
    this.props.soulRevision = revision;
  }

  start(at: Date): void {
    this.transition('running');
    this.props.startedAt = at;
  }

  succeed(at: Date): void {
    this.transition('succeeded');
    this.props.endedAt = at;
  }

  /** The turn asked the owner a question or needs an approval. */
  wait(at: Date): void {
    this.transition('waiting');
    this.props.endedAt = at;
  }

  fail(at: Date, error: string): void {
    this.transition('failed');
    this.props.endedAt = at;
    this.props.error = error;
  }

  cancel(at: Date, reason = 'cancelled'): void {
    this.transition('cancelled');
    this.props.endedAt = at;
    this.props.error = reason;
  }

  /** A plain copy for storage. */
  toProps(): TurnProps {
    return { ...this.props };
  }

  private transition(to: TurnStatus): void {
    if (!Turn.canTransition(this.props.status, to)) {
      throw new InvalidTransition('Turn', this.props.status, to);
    }
    this.props.status = to;
  }
}
