import type { MessageId, OwnerId, SessionId, ThreadId, TurnId } from '../domain/model/ids.js';
import type { Approval, ApprovalStatus } from '../domain/model/Approval.js';
import type { ApprovalId } from '../domain/model/ids.js';
import type { Message } from '../domain/model/Message.js';
import type { Money } from '../domain/model/Money.js';
import type { Session } from '../domain/model/Session.js';
import type { Thread } from '../domain/model/Thread.js';
import type { Turn, TurnStatus } from '../domain/model/Turn.js';
import type { BudgetStore } from './BudgetStore.js';
import type { ChannelBindingStore } from './ChannelBindingStore.js';
import type { SoulStore } from './SoulStore.js';

/**
 * An open transaction. Opaque to callers: pass it to repository methods so several writes commit or
 * roll back together. Methods called without one run on their own. The Postgres adapter wraps a Kysely
 * transaction; nothing outside an adapter can open or end one.
 */
export interface Transaction {
  readonly isTransaction: true;
}

/**
 * The one place that decides what commits. The turn runtime wraps a state change and the messages it
 * produced in one transaction, so a restart never sees one without the other.
 */
export interface UnitOfWork {
  /** Runs fn in one transaction: committed if it resolves, rolled back if it throws. */
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** The single person this install serves; the profile is shown to the model as context. */
export interface Owner {
  id: OwnerId;
  displayName: string;
  timezone: string;
  locale: string;
}

/** The owner profile. One row, seeded by the composition root before the runtime starts. */
export interface OwnerRepository {
  /** Creates the owner or updates its profile fields. `createShitsuji` seeds the fixed `owner` id. */
  upsert(owner: Owner, tx?: Transaction): Promise<void>;
  /** The owner, or undefined before the first upsert. */
  get(id: OwnerId, tx?: Transaction): Promise<Owner | undefined>;
}

/** The owner's one thread. There is no delete: messages stay for the transcript and the audit trail. */
export interface ThreadRepository {
  /**
   * The owner's active thread, created on first use. Two processes starting at once are safe: the
   * insert relies on a partial unique index over active threads, so the loser reads the winner's row.
   */
  getOrCreateForOwner(ownerId: OwnerId, now: Date, tx?: Transaction): Promise<Thread>;
  get(id: ThreadId, tx?: Transaction): Promise<Thread | undefined>;
}

/**
 * Sessions of a thread. A session is created once and then only gains a compaction summary, so there
 * is no update path for its other fields.
 */
export interface SessionRepository {
  insert(session: Session, tx?: Transaction): Promise<void>;
  get(id: SessionId, tx?: Transaction): Promise<Session | undefined>;
  /** The thread's oldest `chat` session: where owner messages go unless another session is named. */
  findMainChat(threadId: ThreadId, tx?: Transaction): Promise<Session | undefined>;
  /** Every session of the thread, oldest first. */
  listByThread(threadId: ThreadId, tx?: Transaction): Promise<Session[]>;
  /**
   * Replaces the compaction summary and how many of the oldest messages it covers. The transcript
   * itself is never deleted (F04).
   */
  setSummary(id: SessionId, summary: string, summaryCount: number, tx?: Transaction): Promise<void>;
}

/**
 * Turn storage. Every write after the start is a compare-and-set, which is what lets several workers
 * and processes share one database: the loser of a race gets `false` and must not report an outcome.
 */
export interface TurnRepository {
  insert(turn: Turn, tx?: Transaction): Promise<void>;
  get(id: TurnId, tx?: Transaction): Promise<Turn | undefined>;
  /** Like get, but locks the row until the transaction ends (SELECT … FOR UPDATE). Needs a tx. */
  getForUpdate(id: TurnId, tx: Transaction): Promise<Turn | undefined>;
  /**
   * Saves the turn only if its stored status is still `expected` (compare-and-set), so two workers can
   * never both move the same turn. Returns false, and writes nothing, if someone else got there first.
   */
  update(turn: Turn, expected: TurnStatus, tx?: Transaction): Promise<boolean>;
  /** All turns in one status, across sessions; `StartupRecovery` uses this for `running` rows. */
  listByStatus(status: TurnStatus, tx?: Transaction): Promise<Turn[]>;
  /** The session's turns in creation order: the scheduler and Stop both read this. */
  listBySession(sessionId: SessionId, tx?: Transaction): Promise<Turn[]>;
}

/** Narrowing options for a transcript read. */
export interface MessageQuery {
  /** Only the most recent `limit` messages (still returned oldest first). */
  limit?: number;
}

/**
 * The transcript. Messages are appended, never updated; withdrawal is the one exception and is
 * recorded on the row. Foreign keys put a message under its thread, session and turn.
 */
export interface MessageRepository {
  append(message: Message, tx?: Transaction): Promise<void>;
  get(id: MessageId, tx?: Transaction): Promise<Message | undefined>;
  /** Marks the owner's messages of a turn as withdrawn (Stop): they no longer feed the model. */
  withdrawByTurn(turnId: TurnId, tx?: Transaction): Promise<number>;
  /** The session's messages, oldest first. Withdrawn messages are included and flagged. */
  listBySession(sessionId: SessionId, query?: MessageQuery, tx?: Transaction): Promise<Message[]>;
  /**
   * The owner's messages stored with one turn, oldest first; withdrawn messages are included and
   * flagged so the caller can filter them. Used to find a steered message without a size window.
   */
  listOwnerByTurn(turnId: TurnId, tx?: Transaction): Promise<Message[]>;
}

/**
 * What a turn event records: a model call and its usage, a model failure, the start and end of a tool
 * call (with its redacted arguments and trust basis), or a free note.
 */
export type TurnEventKind = 'model_call' | 'model_error' | 'tool_start' | 'tool_end' | 'note';

/** An append-only record of what happened during a turn, for receipts and debugging (redacted). */
export interface TurnEvent {
  turnId: TurnId;
  kind: TurnEventKind;
  data: Record<string, unknown>;
  at: Date;
}

/** The per-turn event log. Append-only and redacted; it is the receipt behind an activity view. */
export interface TurnEventRepository {
  append(event: TurnEvent, tx?: Transaction): Promise<void>;
  /** Every event of the turn, oldest first. */
  listByTurn(turnId: TurnId, tx?: Transaction): Promise<TurnEvent[]>;
  /** The owner's recent events, newest first, for the activity log (F22). */
  listRecent(ownerId: OwnerId, query?: TurnEventQuery, tx?: Transaction): Promise<TurnEvent[]>;
}

/** Filters for the activity log; an unset field does not filter. */
export interface TurnEventQuery {
  /** Only these kinds; every kind when unset. */
  kinds?: readonly TurnEventKind[];
  /** Only events at or after this time. */
  since?: Date;
  /** Newest first, at most this many. */
  limit?: number;
}

/** An approval waiting for the owner, or what became of one (F11, S36). */
export interface ApprovalQuery {
  status?: ApprovalStatus | readonly ApprovalStatus[];
  turnId?: TurnId;
  /** Newest first, at most this many. */
  limit?: number;
}

/** Approval cards. Like turns, an approval changes only through a compare-and-set on its status. */
export interface ApprovalRepository {
  insert(approval: Approval, tx?: Transaction): Promise<void>;
  get(id: ApprovalId, tx?: Transaction): Promise<Approval | undefined>;
  /** Compare-and-set on the status; false when someone else moved it first. */
  update(approval: Approval, expected: ApprovalStatus, tx?: Transaction): Promise<boolean>;
  /** Newest first. */
  list(query?: ApprovalQuery, tx?: Transaction): Promise<Approval[]>;
}

/**
 * One model request: what it cost in tokens and, when the price is known, money (F03, F22). Written
 * after the response, never before, so the ledger only holds requests that were actually made.
 */
export interface UsageRecord {
  ownerId: OwnerId;
  /** The turn that made the request, when the call came from a turn. */
  turnId?: TurnId;
  sessionId?: SessionId;
  /** The routing purpose ("chat", "summarize", "trust"…), for the per-purpose breakdown. */
  purpose?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** True when no owner message started the work that caused this request. */
  background?: boolean;
  /** Undefined when the model has no configured price. */
  cost?: Money;
  at: Date;
}

/**
 * The append-only ledger of model spending. The budget reads it for settled spend; the usage API
 * aggregates it. A failed write is logged by the metering decorator and never thrown, so a reply is
 * not lost to a ledger problem.
 */
export interface UsageRepository {
  append(record: UsageRecord, tx?: Transaction): Promise<void>;
  /** Records at or after `since`, oldest first. */
  listSince(ownerId: OwnerId, since: Date, tx?: Transaction): Promise<UsageRecord[]>;
}

/**
 * Every repository plus the unit of work that spans them. One adapter provides all of them, so a
 * transaction can cover writes to several aggregates (`PostgresRepositories`, `InMemoryRepositories`).
 * Services depend on this one object; they never reach for a connection or an adapter.
 */
export interface Repositories {
  uow: UnitOfWork;
  owners: OwnerRepository;
  threads: ThreadRepository;
  sessions: SessionRepository;
  turns: TurnRepository;
  messages: MessageRepository;
  turnEvents: TurnEventRepository;
  usage: UsageRepository;
  soul: SoulStore;
  budget: BudgetStore;
  bindings: ChannelBindingStore;
  approvals: ApprovalRepository;
}
