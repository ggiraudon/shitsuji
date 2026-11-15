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
} from '../../ports/Repositories.js';
import type { Database, MessagesTable, SessionsTable, TurnsTable } from './schema.js';

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

/** The Kysely transaction behind a port Transaction, for adapters that share it (e.g. jobs). */
export function kyselyOf(tx: Transaction): KyselyTx<Database> {
  if (!(tx instanceof PgTransaction)) throw new TypeError('Not a Postgres transaction');
  return tx.trx;
}

/** Repositories on Postgres via Kysely. Pass a Transaction to join a unit of work. */
export class PostgresRepositories implements Repositories {
  constructor(private readonly db: Kysely<Database>) {}

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
}

/** INSERT … SELECT inserts nothing when the parent row is missing; make that an error. */
function assertInserted(result: { numInsertedOrUpdatedRows?: bigint }[], parent: string): void {
  const n = result.reduce((sum, r) => sum + Number(r.numInsertedOrUpdatedRows ?? 0n), 0);
  if (n === 0) throw new Error(`Insert failed: ${parent} does not exist`);
}
