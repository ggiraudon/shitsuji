import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresRepositories } from '../../src/adapters/postgres/PostgresRepositories.js';
import type { Database } from '../../src/adapters/postgres/schema.js';
import { TurnLock, TurnNoLongerActive } from '../../src/application/TurnLock.js';
import { asId, newId, type OwnerId } from '../../src/domain/model/ids.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import { describeRepositoryContract } from '../contracts/repositories.contract.js';
import { closeAll, freshDatabase } from './postgres.js';

afterAll(closeAll);

describeRepositoryContract('PostgresRepositories', async () => {
  const { database } = await freshDatabase();
  return new PostgresRepositories(database.db);
});

const owner: OwnerId = asId('owner');

async function seeded() {
  const { database } = await freshDatabase();
  const repos = new PostgresRepositories(database.db);
  await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
  const thread = await repos.threads.getOrCreateForOwner(owner, new Date());
  const session = new Session(newId(), thread.id, 'chat', new Date());
  await repos.sessions.insert(session);
  const turn = Turn.create({
    id: newId(),
    sessionId: session.id,
    source: 'user',
    createdAt: new Date(),
  });
  await repos.turns.insert(turn);
  return { database, repos, session, turn };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Postgres-only guarantees', () => {
  it('lets only one of many concurrent workers start a turn', async () => {
    const { repos, turn } = await seeded();
    // Every worker reads the turn while it is still queued, then they all race to save "running".
    const copies = await Promise.all(Array.from({ length: 10 }, () => repos.turns.get(turn.id)));
    const attempts = await Promise.all(
      copies.map((copy) => {
        copy!.start(new Date());
        return repos.turns.update(copy!, 'queued');
      }),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect((await repos.turns.get(turn.id))!.status).toBe('running');
  });

  it('creates exactly one active thread when first messages race', async () => {
    const { database } = await freshDatabase();
    const repos = new PostgresRepositories(database.db);
    await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
    const threads = await Promise.all(
      Array.from({ length: 8 }, () => repos.threads.getOrCreateForOwner(owner, new Date())),
    );
    expect(new Set(threads.map((t) => t.id)).size).toBe(1);
  });

  it('TurnLock writes while the turn runs and refuses once it has stopped', async () => {
    const { repos, turn } = await seeded();
    const lock = new TurnLock(repos);
    const running = (await repos.turns.get(turn.id))!;
    running.start(new Date());
    await repos.turns.update(running, 'queued');

    await expect(lock.write(turn.id, async () => 'written')).resolves.toBe('written');

    running.cancel(new Date(), 'stopped by owner');
    await repos.turns.update(running, 'running');
    await expect(lock.write(turn.id, async () => 'late')).rejects.toThrow(TurnNoLongerActive);
  });

  it('TurnLock makes a concurrent Stop wait until the write commits', async () => {
    const { repos, turn } = await seeded();
    const running = (await repos.turns.get(turn.id))!;
    running.start(new Date());
    await repos.turns.update(running, 'queued');
    const order: string[] = [];

    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    const write = new TurnLock(repos).write(turn.id, async () => {
      order.push('write started');
      await holding;
      order.push('write committed');
    });
    await pause(50);
    const stop = (async () => {
      const t = (await repos.turns.get(turn.id))!;
      t.cancel(new Date());
      const ok = await repos.turns.update(t, 'running'); // waits for the row lock
      order.push(`stop ${ok}`);
    })();
    await pause(100);
    release();
    await Promise.all([write, stop]);
    expect(order).toEqual(['write started', 'write committed', 'stop true']);
  });

  it('refuses rows whose parent does not exist', async () => {
    const { repos } = await seeded();
    await expect(
      repos.sessions.insert(new Session(newId(), asId('missing-thread'), 'chat', new Date())),
    ).rejects.toThrow(/thread missing-thread does not exist/);
  });

  it('fills owner_id on every table from the parent row', async () => {
    const { database, repos, session, turn } = await seeded();
    await repos.turnEvents.append({ turnId: turn.id, kind: 'note', data: {}, at: new Date() });
    await repos.messages.append({
      id: newId(),
      threadId: session.threadId,
      sessionId: session.id,
      role: 'user',
      author: 'owner',
      parts: [{ type: 'text', text: 'hi' }],
      withdrawn: false,
      createdAt: new Date(),
    });
    for (const table of ['threads', 'sessions', 'turns', 'messages', 'turn_events'] as const) {
      const rows = await database.db.selectFrom(table).select('owner_id').execute();
      expect(rows.length, table).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.owner_id)), table).toEqual(new Set(['owner']));
    }
  });

  it('matches the migrated schema: every typed table and column exists', async () => {
    const { database } = await freshDatabase();
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
    `.execute(database.db);
    const actual = new Set(columns.rows.map((c) => `${c.table_name}.${c.column_name}`));
    const expected: Record<keyof Database, string[]> = {
      owners: ['id', 'display_name', 'timezone', 'locale', 'settings', 'created_at'],
      threads: ['id', 'owner_id', 'status', 'created_at'],
      sessions: ['id', 'owner_id', 'thread_id', 'kind', 'summary', 'created_at'],
      turns: [
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
      ],
      messages: [
        'seq',
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
      ],
      turn_events: ['id', 'owner_id', 'turn_id', 'kind', 'data', 'at'],
      channel_bindings: ['channel', 'external_chat_id', 'owner_id', 'verified_at'],
    };
    for (const [table, cols] of Object.entries(expected)) {
      for (const col of cols) expect(actual.has(`${table}.${col}`), `${table}.${col}`).toBe(true);
    }
  });

  it('applies migrations once: running them again changes nothing', async () => {
    const { database } = await freshDatabase();
    await expect(database.migrate()).resolves.toEqual([]);
  });
});
