import { sql, type Kysely, type Selectable, type Transaction as KyselyTx } from 'kysely';
import {
  newId,
  type MessageId,
  type OwnerId,
  type SessionId,
  type ThreadId,
  type TurnId,
} from '../../domain/model/ids.js';
import type { ContentPart, Message } from '../../domain/model/Message.js';
import { Session } from '../../domain/model/Session.js';
import type { SoulFragment, SoulRevision } from '../../domain/model/Soul.js';
import { Thread } from '../../domain/model/Thread.js';
import { Turn, type TurnStatus } from '../../domain/model/Turn.js';
import type {
  MessageRepository,
  OwnerRepository,
  Repositories,
  SessionRepository,
  ThreadRepository,
  Transaction,
  TurnEventKind,
  TurnEventRepository,
  TurnRepository,
  UnitOfWork,
  UsageRecord,
  UsageRepository,
} from '../../ports/Repositories.js';
import { Money } from '../../domain/model/Money.js';
import { assertSameCurrency, type BudgetStore } from '../../ports/BudgetStore.js';
import type { SoulStore } from '../../ports/SoulStore.js';
import type {
  Database,
  MessagesTable,
  SessionsTable,
  SoulFragmentsTable,
  SoulRevisionsTable,
  TurnsTable,
} from './schema.js';

/** The port's opaque Transaction, carrying the Kysely transaction it stands for. */
class PgTransaction implements Transaction {
  readonly isTransaction = true as const;
  constructor(readonly trx: KyselyTx<Database>) {}
}

const optional = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

const toSession = (r: Selectable<SessionsTable>) =>
  new Session(
    r.id as SessionId,
    r.thread_id as ThreadId,
    r.kind,
    r.created_at,
    optional(r.summary),
    r.summary_count,
  );

const toTurn = (r: Selectable<TurnsTable>) =>
  Turn.restore({
    id: r.id as TurnId,
    sessionId: r.session_id as SessionId,
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
    parentTurnId: optional(r.parent_turn_id) as TurnId | undefined,
    startAfter: optional(r.start_after),
    replyChannel: optional(r.reply_channel),
    startedAt: optional(r.started_at),
    endedAt: optional(r.ended_at),
    error: optional(r.error),
    soulRevision: optional(r.soul_revision),
  });

const toMessage = (r: Selectable<MessagesTable>): Message => {
  const m: Message = {
    id: r.id as MessageId,
    threadId: r.thread_id as ThreadId,
    sessionId: r.session_id as SessionId,
    role: r.role,
    author: r.author,
    parts: r.content as ContentPart[],
    withdrawn: r.withdrawn,
    createdAt: r.created_at,
  };
  if (r.turn_id !== null) m.turnId = r.turn_id as TurnId;
  if (r.channel !== null) m.channel = r.channel;
  if (r.external_ref !== null) m.externalRef = r.external_ref;
  return m;
};

const toFragment = (r: Selectable<SoulFragmentsTable>): SoulFragment => {
  const fragment: SoulFragment = {
    id: r.id,
    kind: r.kind,
    body: r.body,
    position: r.position,
  };
  if (r.session_kind !== null) fragment.sessionKind = r.session_kind;
  return fragment;
};

const toRevision = (r: Selectable<SoulRevisionsTable>): SoulRevision => ({
  revision: r.revision,
  body: r.body,
  fragments: r.fragments as SoulFragment[],
  source: r.source,
  createdAt: r.created_at,
});

/** The Kysely transaction behind a port Transaction, for adapters that share it (e.g. jobs). */
export function kyselyOf(tx: Transaction): KyselyTx<Database> {
  if (!(tx instanceof PgTransaction)) throw new TypeError('Not a Postgres transaction');
  return tx.trx;
}

/** Repositories on Postgres via Kysely. Pass a Transaction to join a unit of work. */
export class PostgresRepositories implements Repositories {
  readonly usage: UsageRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.usage = usageRepository((tx) => this.ex(tx));
  }

  /** The executor for a call: the transaction if one is given, else the pool. */
  private ex(tx?: Transaction): Kysely<Database> {
    if (!tx) return this.db;
    if (!(tx instanceof PgTransaction)) throw new TypeError('Not a Postgres transaction');
    return tx.trx;
  }

  readonly uow: UnitOfWork = {
    run: (fn) => this.db.transaction().execute((trx) => fn(new PgTransaction(trx))),
  };

  readonly owners: OwnerRepository = {
    upsert: async (o, tx) => {
      await this.ex(tx)
        .insertInto('owners')
        .values({ id: o.id, display_name: o.displayName, timezone: o.timezone, locale: o.locale })
        .onConflict((c) =>
          c.column('id').doUpdateSet({
            display_name: o.displayName,
            timezone: o.timezone,
            locale: o.locale,
          }),
        )
        .execute();
    },
    get: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('owners')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return (
        r && {
          id: r.id as OwnerId,
          displayName: r.display_name,
          timezone: r.timezone,
          locale: r.locale,
        }
      );
    },
  };

  readonly threads: ThreadRepository = {
    getOrCreateForOwner: async (ownerId, now, tx) => {
      const ex = this.ex(tx);
      // ON CONFLICT on the partial unique index makes concurrent first messages safe.
      await ex
        .insertInto('threads')
        .values({ id: newId(), owner_id: ownerId, status: 'active', created_at: now })
        .onConflict((c) => c.column('owner_id').where('status', '=', 'active').doNothing())
        .execute();
      const r = await ex
        .selectFrom('threads')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      return new Thread(r.id as ThreadId, r.owner_id as OwnerId, r.created_at, r.status);
    },
    get: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('threads')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r && new Thread(r.id as ThreadId, r.owner_id as OwnerId, r.created_at, r.status);
    },
  };

  readonly sessions: SessionRepository = {
    insert: async (s, tx) => {
      await this.ex(tx)
        .insertInto('sessions')
        .columns(['id', 'owner_id', 'thread_id', 'kind', 'summary', 'created_at'])
        .expression((eb) =>
          eb
            .selectFrom('threads')
            .select([
              sql<string>`${s.id}::text`.as('id'),
              'owner_id',
              'id as thread_id',
              sql<string>`${s.kind}::text`.as('kind'),
              sql<string | null>`${s.summary ?? null}::text`.as('summary'),
              sql<Date>`${s.createdAt}::timestamptz`.as('created_at'),
            ])
            .where('id', '=', s.threadId),
        )
        .execute()
        .then((r) => assertInserted(r, `thread ${s.threadId}`));
    },
    get: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r && toSession(r);
    },
    findMainChat: async (threadId, tx) => {
      const r = await this.ex(tx)
        .selectFrom('sessions')
        .selectAll()
        .where('thread_id', '=', threadId)
        .where('kind', '=', 'chat')
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      return r && toSession(r);
    },
    listByThread: async (threadId, tx) =>
      (
        await this.ex(tx)
          .selectFrom('sessions')
          .selectAll()
          .where('thread_id', '=', threadId)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      ).map(toSession),
    setSummary: async (id, summary, summaryCount, tx) => {
      const r = await this.ex(tx)
        .updateTable('sessions')
        .set({ summary, summary_count: summaryCount })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new Error(`Session ${id} not found`);
    },
  };

  readonly turns: TurnRepository = {
    insert: async (turn, tx) => {
      const p = turn.toProps();
      await this.ex(tx)
        .insertInto('turns')
        .columns([
          'id',
          'owner_id',
          'session_id',
          'source',
          'status',
          'parent_turn_id',
          'start_after',
          'reply_channel',
          'error',
          'created_at',
          'started_at',
          'ended_at',
          'soul_revision',
        ])
        .expression((eb) =>
          eb
            .selectFrom('sessions')
            .select([
              sql<string>`${p.id}::text`.as('id'),
              'owner_id',
              'id as session_id',
              sql<string>`${p.source}::text`.as('source'),
              sql<string>`${p.status}::text`.as('status'),
              sql<string | null>`${p.parentTurnId ?? null}::text`.as('parent_turn_id'),
              sql<Date | null>`${p.startAfter ?? null}::timestamptz`.as('start_after'),
              sql<string | null>`${p.replyChannel ?? null}::text`.as('reply_channel'),
              sql<string | null>`${p.error ?? null}::text`.as('error'),
              sql<Date>`${p.createdAt}::timestamptz`.as('created_at'),
              sql<Date | null>`${p.startedAt ?? null}::timestamptz`.as('started_at'),
              sql<Date | null>`${p.endedAt ?? null}::timestamptz`.as('ended_at'),
              sql<number | null>`${p.soulRevision ?? null}::integer`.as('soul_revision'),
            ])
            .where('id', '=', p.sessionId),
        )
        .execute()
        .then((r) => assertInserted(r, `session ${p.sessionId}`));
    },
    get: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('turns')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r && toTurn(r);
    },
    getForUpdate: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('turns')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      return r && toTurn(r);
    },
    update: async (turn, expected: TurnStatus, tx) => {
      const p = turn.toProps();
      const result = await this.ex(tx)
        .updateTable('turns')
        .set({
          status: p.status,
          error: p.error ?? null,
          started_at: p.startedAt ?? null,
          ended_at: p.endedAt ?? null,
          start_after: p.startAfter ?? null,
          reply_channel: p.replyChannel ?? null,
          soul_revision: p.soulRevision ?? null,
        })
        .where('id', '=', p.id)
        .where('status', '=', expected)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    listByStatus: async (status, tx) =>
      (
        await this.ex(tx)
          .selectFrom('turns')
          .selectAll()
          .where('status', '=', status)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      ).map(toTurn),
    listBySession: async (sessionId, tx) =>
      (
        await this.ex(tx)
          .selectFrom('turns')
          .selectAll()
          .where('session_id', '=', sessionId)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      ).map(toTurn),
  };

  readonly messages: MessageRepository = {
    append: async (m, tx) => {
      await this.ex(tx)
        .insertInto('messages')
        .columns([
          'id',
          'owner_id',
          'thread_id',
          'session_id',
          'turn_id',
          'role',
          'author',
          'content',
          'channel',
          'external_ref',
          'withdrawn',
          'created_at',
        ])
        .expression((eb) =>
          eb
            .selectFrom('threads')
            .select([
              sql<string>`${m.id}::text`.as('id'),
              'owner_id',
              'id as thread_id',
              sql<string>`${m.sessionId}::text`.as('session_id'),
              sql<string | null>`${m.turnId ?? null}::text`.as('turn_id'),
              sql<string>`${m.role}::text`.as('role'),
              sql<string>`${m.author}::text`.as('author'),
              sql<string>`${JSON.stringify(m.parts)}::jsonb`.as('content'),
              sql<string | null>`${m.channel ?? null}::text`.as('channel'),
              sql<string | null>`${m.externalRef ?? null}::text`.as('external_ref'),
              sql<boolean>`${m.withdrawn}::boolean`.as('withdrawn'),
              sql<Date>`${m.createdAt}::timestamptz`.as('created_at'),
            ])
            .where('id', '=', m.threadId),
        )
        .execute()
        .then((r) => assertInserted(r, `thread ${m.threadId}`));
    },
    get: async (id, tx) => {
      const r = await this.ex(tx)
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r && toMessage(r);
    },
    withdrawByTurn: async (turnId, tx) => {
      const r = await this.ex(tx)
        .updateTable('messages')
        .set({ withdrawn: true })
        .where('turn_id', '=', turnId)
        .where('author', '=', 'owner')
        .where('withdrawn', '=', false)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    listBySession: async (sessionId, query = {}, tx) => {
      let q = this.ex(tx).selectFrom('messages').selectAll().where('session_id', '=', sessionId);
      if (query.limit !== undefined) {
        q = q.orderBy('seq', 'desc').limit(query.limit);
        return (await q.execute()).reverse().map(toMessage);
      }
      return (await q.orderBy('seq').execute()).map(toMessage);
    },
  };

  readonly turnEvents: TurnEventRepository = {
    append: async (e, tx) => {
      await this.ex(tx)
        .insertInto('turn_events')
        .columns(['owner_id', 'turn_id', 'kind', 'data', 'at'])
        .expression((eb) =>
          eb
            .selectFrom('turns')
            .select([
              'owner_id',
              'id as turn_id',
              sql<string>`${e.kind}::text`.as('kind'),
              sql<string>`${JSON.stringify(e.data)}::jsonb`.as('data'),
              sql<Date>`${e.at}::timestamptz`.as('at'),
            ])
            .where('id', '=', e.turnId),
        )
        .execute()
        .then((r) => assertInserted(r, `turn ${e.turnId}`));
    },
    listByTurn: async (turnId, tx) =>
      (
        await this.ex(tx)
          .selectFrom('turn_events')
          .selectAll()
          .where('turn_id', '=', turnId)
          .orderBy('id')
          .execute()
      ).map((r) => ({
        turnId: r.turn_id as TurnId,
        kind: r.kind as TurnEventKind,
        data: r.data,
        at: r.at,
      })),
  };

  readonly soul: SoulStore = {
    fragments: async (ownerId, tx) =>
      (
        await this.ex(tx)
          .selectFrom('soul_fragments')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .orderBy('position')
          .orderBy('id')
          .execute()
      ).map(toFragment),
    replaceFragments: async (ownerId, fragments, at, tx) => {
      const ex = this.ex(tx);
      await ex.deleteFrom('soul_fragments').where('owner_id', '=', ownerId).execute();
      if (!fragments.length) return;
      await ex
        .insertInto('soul_fragments')
        .values(
          fragments.map((f) => ({
            id: f.id,
            owner_id: ownerId,
            kind: f.kind,
            session_kind: f.sessionKind ?? null,
            body: f.body,
            position: f.position,
            created_at: at,
            updated_at: at,
          })),
        )
        .execute();
    },
    currentRevision: async (ownerId, tx) => {
      const r = await this.ex(tx)
        .selectFrom('soul_revisions')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .orderBy('revision', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r && toRevision(r);
    },
    revisions: async (ownerId, tx) =>
      (
        await this.ex(tx)
          .selectFrom('soul_revisions')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .orderBy('revision')
          .execute()
      ).map(toRevision),
    appendRevision: async (ownerId, r, tx) => {
      await this.ex(tx)
        .insertInto('soul_revisions')
        .values({
          owner_id: ownerId,
          revision: r.revision,
          body: r.body,
          fragments: JSON.stringify(r.fragments),
          source: r.source,
          created_at: r.createdAt,
        })
        .execute();
    },
  };

  readonly budget: BudgetStore = {
    reserve: async (input) => {
      assertSameCurrency(input.amount, input.limits);
      // One owner (P1): locking that row serialises budget decisions across cores.
      return this.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('owners')
          .select('id')
          .where('id', '=', input.ownerId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const monthlyUsed = (
          await usageTotal(trx, input.ownerId, input.since, input.amount.currency)
        ).plus(await heldTotal(trx, input.ownerId, input.since, input.amount.currency));
        const backgroundUsed = (
          await usageTotal(trx, input.ownerId, input.since, input.amount.currency, true)
        ).plus(await heldTotal(trx, input.ownerId, input.since, input.amount.currency, true));
        if (input.enforce && monthlyUsed.plus(input.amount).compare(input.limits.monthly) > 0) {
          return { reserved: false as const, reason: 'monthly_limit' as const };
        }
        if (
          input.background &&
          backgroundUsed.plus(input.amount).compare(input.limits.background) > 0
        ) {
          return { reserved: false as const, reason: 'background_allowance' as const };
        }
        await trx
          .insertInto('budget_reservations')
          .values({
            id: input.id,
            owner_id: input.ownerId,
            amount_micros: input.amount.micros,
            currency: input.amount.currency,
            background: input.background,
            session_id: input.sessionId ?? null,
            turn_id: input.turnId ?? null,
            state: 'held',
            created_at: input.now,
            ended_at: null,
          })
          .execute();
        return {
          reserved: true as const,
          reservation: {
            id: input.id,
            ownerId: input.ownerId,
            amount: input.amount,
            background: input.background,
            ...(input.sessionId && { sessionId: input.sessionId }),
            ...(input.turnId && { turnId: input.turnId }),
            createdAt: input.now,
          },
        };
      });
    },
    settle: async (id, at, tx) => {
      await this.ex(tx)
        .updateTable('budget_reservations')
        .set({ state: 'settled', ended_at: at })
        .where('id', '=', id)
        .where('state', '=', 'held')
        .execute();
    },
    release: async (id, at, tx) => {
      await this.ex(tx)
        .updateTable('budget_reservations')
        .set({ state: 'released', ended_at: at })
        .where('id', '=', id)
        .where('state', '=', 'held')
        .execute();
    },
    heldSince: (ownerId, since, currency, background, tx) =>
      heldTotal(this.ex(tx), ownerId, since, currency, background),
    spentSince: (ownerId, since, currency, background, tx) =>
      usageTotal(this.ex(tx), ownerId, since, currency, background),
    sessionSpentSince: async (ownerId, sessionId, since, currency, tx) =>
      (await usageTotal(this.ex(tx), ownerId, since, currency, undefined, sessionId)).plus(
        await heldTotal(this.ex(tx), ownerId, since, currency, undefined, sessionId),
      ),
    releaseAllHeld: async (at) => {
      const result = await this.ex()
        .updateTable('budget_reservations')
        .set({ state: 'released', ended_at: at })
        .where('state', '=', 'held')
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

/** Not a member above so the class reads in table order; attached in the constructor. */
function usageRepository(ex: (tx?: Transaction) => Kysely<Database>): UsageRepository {
  return {
    append: async (r, tx) => {
      await ex(tx)
        .insertInto('usage')
        .values({
          owner_id: r.ownerId,
          turn_id: r.turnId ?? null,
          session_id: r.sessionId ?? null,
          purpose: r.purpose ?? null,
          provider: r.provider,
          model: r.model,
          input_tokens: r.inputTokens,
          output_tokens: r.outputTokens,
          cached_input_tokens: r.cachedInputTokens ?? null,
          reasoning_tokens: r.reasoningTokens ?? null,
          background: r.background ?? false,
          cost_micros: r.cost?.micros ?? null,
          currency: r.cost?.currency ?? null,
          at: r.at,
        })
        .execute();
    },
    listSince: async (ownerId, since, tx) =>
      (
        await ex(tx)
          .selectFrom('usage')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('at', '>=', since)
          .orderBy('at')
          .orderBy('id')
          .execute()
      ).map((row) => {
        const record: UsageRecord = {
          ownerId: row.owner_id as OwnerId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          at: row.at,
        };
        if (row.turn_id !== null) record.turnId = row.turn_id as TurnId;
        if (row.session_id !== null) record.sessionId = row.session_id as SessionId;
        if (row.purpose !== null) record.purpose = row.purpose;
        if (row.cached_input_tokens !== null) record.cachedInputTokens = row.cached_input_tokens;
        if (row.reasoning_tokens !== null) record.reasoningTokens = row.reasoning_tokens;
        record.background = row.background;
        if (row.cost_micros !== null) {
          record.cost = Money.fromMicros(Number(row.cost_micros), row.currency ?? 'USD');
        }
        return record;
      }),
  };
}

/** INSERT … SELECT inserts nothing when the parent row is missing; make that an error. */
function assertInserted(result: { numInsertedOrUpdatedRows?: bigint }[], parent: string): void {
  const n = result.reduce((sum, r) => sum + Number(r.numInsertedOrUpdatedRows ?? 0n), 0);
  if (n === 0) throw new Error(`Insert failed: ${parent} does not exist`);
}

type QueryExecutor = Kysely<Database> | KyselyTx<Database>;

/** Settled spend from the usage ledger: priced rows in this currency, optionally only background. */
async function usageTotal(
  ex: QueryExecutor,
  ownerId: OwnerId,
  since: Date,
  currency: string,
  background?: boolean,
  sessionId?: SessionId,
): Promise<Money> {
  const row = await ex
    .selectFrom('usage')
    .select(sql<string>`COALESCE(SUM(cost_micros), 0)`.as('total'))
    .where('owner_id', '=', ownerId)
    .where('at', '>=', since)
    .where('currency', '=', currency)
    .where('cost_micros', 'is not', null)
    .$if(background !== undefined, (qb) => qb.where('background', '=', background!))
    .$if(sessionId !== undefined, (qb) => qb.where('session_id', '=', sessionId!))
    .executeTakeFirst();
  return Money.fromMicros(Number(row?.total ?? 0), currency);
}

/** Open holds since the period started, optionally only background ones. */
async function heldTotal(
  ex: QueryExecutor,
  ownerId: OwnerId,
  since: Date,
  currency: string,
  background?: boolean,
  sessionId?: SessionId,
): Promise<Money> {
  const row = await ex
    .selectFrom('budget_reservations')
    .select(sql<string>`COALESCE(SUM(amount_micros), 0)`.as('total'))
    .where('owner_id', '=', ownerId)
    .where('state', '=', 'held')
    .where('created_at', '>=', since)
    .where('currency', '=', currency)
    .$if(background !== undefined, (qb) => qb.where('background', '=', background!))
    .$if(sessionId !== undefined, (qb) => qb.where('session_id', '=', sessionId!))
    .executeTakeFirst();
  return Money.fromMicros(Number(row?.total ?? 0), currency);
}
