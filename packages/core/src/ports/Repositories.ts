import type { MessageId, OwnerId, SessionId, ThreadId, TurnId } from '../domain/model/ids.js';
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
 * roll back together. Methods called without one run on their own.
 */
export interface Transaction {
  readonly isTransaction: true;
}

export interface UnitOfWork {
  /** Runs fn in one transaction: committed if it resolves, rolled back if it throws. */
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface Owner {
  id: OwnerId;
  displayName: string;
  timezone: string;
  locale: string;
}

export interface OwnerRepository {
  /** Creates the owner or updates its profile fields. */
  upsert(owner: Owner, tx?: Transaction): Promise<void>;
  get(id: OwnerId, tx?: Transaction): Promise<Owner | undefined>;
}

export interface ThreadRepository {
  /** The owner's active thread, created on first use. */
  getOrCreateForOwner(ownerId: OwnerId, now: Date, tx?: Transaction): Promise<Thread>;
  get(id: ThreadId, tx?: Transaction): Promise<Thread | undefined>;
}

export interface SessionRepository {
  insert(session: Session, tx?: Transaction): Promise<void>;
  get(id: SessionId, tx?: Transaction): Promise<Session | undefined>;
  /** The thread's oldest `chat` session: where owner messages go unless another session is named. */
  findMainChat(threadId: ThreadId, tx?: Transaction): Promise<Session | undefined>;
  listByThread(threadId: ThreadId, tx?: Transaction): Promise<Session[]>;
  /**
   * Replaces the compaction summary and how many of the oldest messages it covers. The transcript
   * itself is never deleted (F04).
   */
  setSummary(id: SessionId, summary: string, summaryCount: number, tx?: Transaction): Promise<void>;
}

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
  listByStatus(status: TurnStatus, tx?: Transaction): Promise<Turn[]>;
  listBySession(sessionId: SessionId, tx?: Transaction): Promise<Turn[]>;
}

export interface MessageQuery {
  /** Only the most recent `limit` messages (still returned oldest first). */
  limit?: number;
}

export interface MessageRepository {
  append(message: Message, tx?: Transaction): Promise<void>;
  get(id: MessageId, tx?: Transaction): Promise<Message | undefined>;
  /** Marks the owner's messages of a turn as withdrawn (Stop): they no longer feed the model. */
  withdrawByTurn(turnId: TurnId, tx?: Transaction): Promise<number>;
  /** The session's messages, oldest first. Withdrawn messages are included and flagged. */
  listBySession(sessionId: SessionId, query?: MessageQuery, tx?: Transaction): Promise<Message[]>;
}

export type TurnEventKind = 'model_call' | 'model_error' | 'tool_start' | 'tool_end' | 'note';

/** An append-only record of what happened during a turn, for receipts and debugging (redacted). */
export interface TurnEvent {
  turnId: TurnId;
  kind: TurnEventKind;
  data: Record<string, unknown>;
  at: Date;
}

export interface TurnEventRepository {
  append(event: TurnEvent, tx?: Transaction): Promise<void>;
  listByTurn(turnId: TurnId, tx?: Transaction): Promise<TurnEvent[]>;
  /** The owner's recent events, newest first, for the activity log (F22). */
  listRecent(ownerId: OwnerId, query?: TurnEventQuery, tx?: Transaction): Promise<TurnEvent[]>;
}

export interface TurnEventQuery {
  /** Only these kinds; every kind when unset. */
  kinds?: readonly TurnEventKind[];
  since?: Date;
  /** Newest first, at most this many. */
  limit?: number;
}

/** One model request: what it cost in tokens and, when the price is known, money (F03, F22). */
export interface UsageRecord {
  ownerId: OwnerId;
  turnId?: TurnId;
  sessionId?: SessionId;
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

export interface UsageRepository {
  append(record: UsageRecord, tx?: Transaction): Promise<void>;
  /** Records at or after `since`, oldest first. */
  listSince(ownerId: OwnerId, since: Date, tx?: Transaction): Promise<UsageRecord[]>;
}

/** Every repository plus the unit of work that spans them. One adapter provides all of them. */
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
}
