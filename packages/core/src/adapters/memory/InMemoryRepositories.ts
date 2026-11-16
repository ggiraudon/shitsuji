import {
  newId,
  type MessageId,
  type OwnerId,
  type SessionId,
  type ThreadId,
  type TurnId,
} from '../../domain/model/ids.js';
import type { Message } from '../../domain/model/Message.js';
import { Session, type SessionKind } from '../../domain/model/Session.js';
import type { SoulFragment, SoulRevision } from '../../domain/model/Soul.js';
import { Thread, type ThreadStatus } from '../../domain/model/Thread.js';
import { Turn, type TurnProps, type TurnStatus } from '../../domain/model/Turn.js';
import type {
  MessageQuery,
  MessageRepository,
  Owner,
  OwnerRepository,
  Repositories,
  SessionRepository,
  ThreadRepository,
  Transaction,
  TurnEvent,
  TurnEventRepository,
  TurnRepository,
  UnitOfWork,
  UsageRecord,
  UsageRepository,
} from '../../ports/Repositories.js';
import type { SoulStore } from '../../ports/SoulStore.js';
import type { ChannelBinding, ChannelBindingStore } from '../../ports/ChannelBindingStore.js';
import type { BudgetReservation, BudgetStore } from '../../ports/BudgetStore.js';
import { assertSameCurrency } from '../../ports/BudgetStore.js';
import { Money } from '../../domain/model/Money.js';

interface ThreadRow {
  id: ThreadId;
  ownerId: OwnerId;
  status: ThreadStatus;
  createdAt: Date;
}
interface SessionRow {
  id: SessionId;
  threadId: ThreadId;
  kind: SessionKind;
  createdAt: Date;
  summary?: string;
  summaryCount: number;
}

/** A budget hold, kept as plain fields so a transaction can snapshot and restore it. */
interface BudgetHoldRow {
  id: string;
  ownerId: OwnerId;
  amountMicros: number;
  currency: string;
  background: boolean;
  sessionId?: SessionId;
  turnId?: TurnId;
  state: 'held' | 'settled' | 'released';
  createdAt: Date;
  endedAt?: Date;
}

/** Plain records only, so a transaction can snapshot and restore the whole state. */
interface State {
  owners: Map<OwnerId, Owner>;
  threads: Map<ThreadId, ThreadRow>;
  sessions: Map<SessionId, SessionRow>;
  turns: Map<TurnId, TurnProps>;
  messages: Message[];
  turnEvents: TurnEvent[];
  /** Money is stored as plain fields so the state can be cloned. */
  usage: (Omit<UsageRecord, 'cost'> & { costMicros?: number; currency?: string })[];
  soulFragments: { ownerId: OwnerId; fragment: SoulFragment }[];
  soulRevisions: { ownerId: OwnerId; revision: SoulRevision }[];
  budgetHolds: BudgetHoldRow[];
  bindings: ChannelBinding[];
}

const emptyState = (): State => ({
  owners: new Map(),
  threads: new Map(),
  sessions: new Map(),
  turns: new Map(),
  messages: [],
  turnEvents: [],
  usage: [],
  soulFragments: [],
  soulRevisions: [],
  budgetHolds: [],
  bindings: [],
});

const copy = <T>(value: T): T => structuredClone(value);
const toThread = (r: ThreadRow) => new Thread(r.id, r.ownerId, new Date(r.createdAt), r.status);
const toReservation = (row: BudgetHoldRow): BudgetReservation => {
  const reservation: BudgetReservation = {
    id: row.id,
    ownerId: row.ownerId,
    amount: Money.fromMicros(row.amountMicros, row.currency),
    background: row.background,
    createdAt: new Date(row.createdAt),
  };
  if (row.sessionId) reservation.sessionId = row.sessionId;
  if (row.turnId) reservation.turnId = row.turnId;
  return reservation;
};

const toSession = (r: SessionRow) =>
  new Session(r.id, r.threadId, r.kind, new Date(r.createdAt), r.summary, r.summaryCount);

/**
 * Repositories kept in memory, for unit tests and for running without a database. Reads return copies,
 * so changing a returned object never changes stored state. `uow.run` runs one transaction at a time
 * and restores the previous state if the function throws, so tests can rely on rollback.
 */
export class InMemoryRepositories implements Repositories {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  readonly uow: UnitOfWork = {
    run: <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
      const next = this.queue.then(async () => {
        const snapshot = copy(this.state);
        try {
          return await fn({ isTransaction: true });
        } catch (error) {
          this.state = snapshot;
          throw error;
        }
      });
      this.queue = next.catch(() => undefined);
      return next;
    },
  };

  readonly owners: OwnerRepository = {
    upsert: async (owner) => {
      this.state.owners.set(owner.id, copy(owner));
    },
    get: async (id) => {
      const o = this.state.owners.get(id);
      return o && copy(o);
    },
  };

  readonly threads: ThreadRepository = {
    getOrCreateForOwner: async (ownerId, now) => {
      const existing = [...this.state.threads.values()].find(
        (t) => t.ownerId === ownerId && t.status === 'active',
      );
      if (existing) return toThread(existing);
      const row: ThreadRow = { id: newId(), ownerId, status: 'active', createdAt: new Date(now) };
      this.state.threads.set(row.id, row);
      return toThread(row);
    },
    get: async (id) => {
      const r = this.state.threads.get(id);
      return r && toThread(r);
    },
  };

  readonly sessions: SessionRepository = {
    insert: async (s) => {
      if (this.state.sessions.has(s.id)) throw new Error(`Session ${s.id} already exists`);
      this.state.sessions.set(s.id, {
        id: s.id,
        threadId: s.threadId,
        kind: s.kind,
        createdAt: new Date(s.createdAt),
        summary: s.summary,
        summaryCount: s.summaryCount,
      });
    },
    get: async (id) => {
      const r = this.state.sessions.get(id);
      return r && toSession(r);
    },
    findMainChat: async (threadId) => {
      const r = this.sessionsOf(threadId).find((s) => s.kind === 'chat');
      return r && toSession(r);
    },
    listByThread: async (threadId) => this.sessionsOf(threadId).map(toSession),
    setSummary: async (id, summary, summaryCount) => {
      const row = this.state.sessions.get(id);
      if (!row) throw new Error(`Session ${id} not found`);
      row.summary = summary;
      row.summaryCount = summaryCount;
    },
  };

  readonly turns: TurnRepository = {
    insert: async (turn) => {
      if (this.state.turns.has(turn.id)) throw new Error(`Turn ${turn.id} already exists`);
      this.state.turns.set(turn.id, copy(turn.toProps()));
    },
    get: async (id) => {
      const p = this.state.turns.get(id);
      return p && Turn.restore(copy(p));
    },
    // Transactions already run one at a time here, so reading is enough to "lock".
    getForUpdate: async (id) => {
      const p = this.state.turns.get(id);
      return p && Turn.restore(copy(p));
    },
    update: async (turn, expected: TurnStatus) => {
      const stored = this.state.turns.get(turn.id);
      if (!stored || stored.status !== expected) return false;
      this.state.turns.set(turn.id, copy(turn.toProps()));
      return true;
    },
    listByStatus: async (status) =>
      this.sortedTurns()
        .filter((t) => t.status === status)
        .map((p) => Turn.restore(copy(p))),
    listBySession: async (sessionId) =>
      this.sortedTurns()
        .filter((t) => t.sessionId === sessionId)
        .map((p) => Turn.restore(copy(p))),
  };

  readonly messages: MessageRepository = {
    append: async (message) => {
      if (this.state.messages.some((m) => m.id === message.id)) {
        throw new Error(`Message ${message.id} already exists`);
      }
      this.state.messages.push(copy(message));
    },
    get: async (id: MessageId) => {
      const m = this.state.messages.find((x) => x.id === id);
      return m && copy(m);
    },
    withdrawByTurn: async (turnId) => {
      let n = 0;
      for (const m of this.state.messages) {
        if (m.turnId === turnId && m.author === 'owner' && !m.withdrawn) {
          m.withdrawn = true;
          n++;
        }
      }
      return n;
    },
    listBySession: async (sessionId, query: MessageQuery = {}) => {
      const all = this.state.messages.filter((m) => m.sessionId === sessionId);
      const picked = query.limit === undefined ? all : all.slice(-query.limit);
      return picked.map(copy);
    },
  };

  readonly turnEvents: TurnEventRepository = {
    append: async (event) => {
      this.state.turnEvents.push(copy(event));
    },
    listByTurn: async (turnId) =>
      this.state.turnEvents.filter((e) => e.turnId === turnId).map(copy),
    listRecent: async (_ownerId, query = {}) =>
      this.state.turnEvents
        .filter(
          (e) =>
            (!query.kinds || query.kinds.includes(e.kind)) &&
            (!query.since || e.at.getTime() >= query.since.getTime()),
        )
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, query.limit ?? 100)
        .map(copy),
  };

  readonly usage: UsageRepository = {
    append: async (r) => {
      const { cost, ...rest } = r;
      this.state.usage.push(
        copy({
          ...rest,
          background: r.background ?? false,
          costMicros: cost?.micros,
          currency: cost?.currency,
        }),
      );
    },
    listSince: async (ownerId, since) =>
      this.state.usage
        .filter((u) => u.ownerId === ownerId && u.at.getTime() >= since.getTime())
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map(({ costMicros, currency, ...rest }) => {
          const record: UsageRecord = copy(rest);
          if (costMicros !== undefined) record.cost = Money.fromMicros(costMicros, currency);
          return record;
        }),
  };

  readonly soul: SoulStore = {
    fragments: async (ownerId) =>
      this.state.soulFragments
        .filter((f) => f.ownerId === ownerId)
        .map((f) => copy(f.fragment))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    replaceFragments: async (ownerId, fragments) => {
      this.state.soulFragments = this.state.soulFragments.filter((f) => f.ownerId !== ownerId);
      for (const fragment of fragments) {
        this.state.soulFragments.push({ ownerId, fragment: copy(fragment) });
      }
    },
    currentRevision: async (ownerId) => {
      const all = this.revisionsOf(ownerId);
      return all.at(-1);
    },
    revisions: async (ownerId) => this.revisionsOf(ownerId),
    appendRevision: async (ownerId, revision) => {
      if (
        this.state.soulRevisions.some(
          (r) => r.ownerId === ownerId && r.revision.revision === revision.revision,
        )
      ) {
        throw new Error(`SOUL revision ${revision.revision} already exists`);
      }
      this.state.soulRevisions.push({ ownerId, revision: copy(revision) });
    },
  };

  readonly budget: BudgetStore = {
    reserve: (input) =>
      this.uow.run(async () => {
        assertSameCurrency(input.amount, input.limits);
        const monthlyUsed = this.spentTotal(input.ownerId, input.since, input.amount.currency).plus(
          this.heldTotal(input.ownerId, input.since, input.amount.currency),
        );
        const backgroundUsed = this.spentTotal(
          input.ownerId,
          input.since,
          input.amount.currency,
          true,
        ).plus(this.heldTotal(input.ownerId, input.since, input.amount.currency, true));
        if (input.enforce && monthlyUsed.plus(input.amount).compare(input.limits.monthly) > 0) {
          return { reserved: false as const, reason: 'monthly_limit' as const };
        }
        if (
          input.background &&
          backgroundUsed.plus(input.amount).compare(input.limits.background) > 0
        ) {
          return { reserved: false as const, reason: 'background_allowance' as const };
        }
        const row: BudgetHoldRow = {
          id: input.id,
          ownerId: input.ownerId,
          amountMicros: input.amount.micros,
          currency: input.amount.currency,
          background: input.background,
          state: 'held',
          createdAt: new Date(input.now),
          ...(input.sessionId && { sessionId: input.sessionId }),
          ...(input.turnId && { turnId: input.turnId }),
        };
        this.state.budgetHolds.push(copy(row));
        return { reserved: true as const, reservation: toReservation(row) };
      }),
    settle: async (id, at) => {
      const row = this.state.budgetHolds.find((h) => h.id === id && h.state === 'held');
      if (row) {
        row.state = 'settled';
        row.endedAt = new Date(at);
      }
    },
    release: async (id, at) => {
      const row = this.state.budgetHolds.find((h) => h.id === id && h.state === 'held');
      if (row) {
        row.state = 'released';
        row.endedAt = new Date(at);
      }
    },
    heldSince: async (ownerId, since, currency, background) =>
      this.heldTotal(ownerId, since, currency, background),
    spentSince: async (ownerId, since, currency, background) =>
      this.spentTotal(ownerId, since, currency, background),
    sessionSpentSince: async (ownerId, sessionId, since, currency) => {
      const at = since.getTime();
      const usage = this.state.usage
        .filter(
          (u) =>
            u.ownerId === ownerId &&
            u.sessionId === sessionId &&
            u.currency === currency &&
            u.costMicros !== undefined &&
            u.at.getTime() > at,
        )
        .reduce((sum, u) => sum + (u.costMicros ?? 0), 0);
      const held = this.state.budgetHolds
        .filter(
          (h) =>
            h.ownerId === ownerId &&
            h.sessionId === sessionId &&
            h.state === 'held' &&
            h.currency === currency &&
            h.createdAt.getTime() > at,
        )
        .reduce((sum, h) => sum + h.amountMicros, 0);
      return Money.fromMicros(usage + held, currency);
    },
    releaseAllHeld: async (at) => {
      let released = 0;
      for (const row of this.state.budgetHolds) {
        if (row.state !== 'held') continue;
        row.state = 'released';
        row.endedAt = new Date(at);
        released++;
      }
      return released;
    },
  };

  readonly bindings: ChannelBindingStore = {
    get: async (channel, externalChatId) => {
      const row = this.state.bindings.find(
        (b) => b.channel === channel && b.externalChatId === externalChatId,
      );
      return row && copy(row);
    },
    upsert: async (binding) => {
      const at = this.state.bindings.findIndex(
        (b) => b.channel === binding.channel && b.externalChatId === binding.externalChatId,
      );
      if (at === -1) this.state.bindings.push(copy(binding));
      else this.state.bindings[at] = copy(binding);
    },
    listByOwner: async (ownerId) =>
      this.state.bindings
        .filter((b) => b.ownerId === ownerId)
        .map(copy)
        .sort(
          (a, b) =>
            a.channel.localeCompare(b.channel) || a.externalChatId.localeCompare(b.externalChatId),
        ),
  };

  /** Settled spend from the usage ledger: rows with a known cost, in this currency. */
  private spentTotal(
    ownerId: OwnerId,
    since: Date,
    currency: string,
    background?: boolean,
    sessionId?: SessionId,
  ): Money {
    const micros = this.state.usage
      .filter(
        (u) =>
          u.ownerId === ownerId &&
          u.at.getTime() >= since.getTime() &&
          u.currency === currency &&
          u.costMicros !== undefined &&
          (background === undefined || u.background === background) &&
          (sessionId === undefined || u.sessionId === sessionId),
      )
      .reduce((sum, u) => sum + (u.costMicros ?? 0), 0);
    return Money.fromMicros(micros, currency);
  }

  /** Open holds since the period started. */
  private heldTotal(
    ownerId: OwnerId,
    since: Date,
    currency: string,
    background?: boolean,
    sessionId?: SessionId,
  ): Money {
    const micros = this.state.budgetHolds
      .filter(
        (h) =>
          h.ownerId === ownerId &&
          h.state === 'held' &&
          h.currency === currency &&
          h.createdAt.getTime() >= since.getTime() &&
          (background === undefined || h.background === background) &&
          (sessionId === undefined || h.sessionId === sessionId),
      )
      .reduce((sum, h) => sum + h.amountMicros, 0);
    return Money.fromMicros(micros, currency);
  }

  private revisionsOf(ownerId: OwnerId): SoulRevision[] {
    return this.state.soulRevisions
      .filter((r) => r.ownerId === ownerId)
      .map((r) => copy(r.revision))
      .sort((a, b) => a.revision - b.revision);
  }

  private sessionsOf(threadId: ThreadId): SessionRow[] {
    return [...this.state.sessions.values()]
      .filter((s) => s.threadId === threadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private sortedTurns(): TurnProps[] {
    return [...this.state.turns.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
}
