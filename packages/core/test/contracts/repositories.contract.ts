/**
 * The behaviour every Repositories adapter must have. Run against the in-memory adapter in unit tests
 * and against Postgres in integration tests, so both behave the same.
 */
import { describe, expect, it } from 'vitest';
import { asId, newId, type OwnerId, type SessionId } from '../../src/domain/model/ids.js';
import type { Message } from '../../src/domain/model/Message.js';
import { Money } from '../../src/domain/model/Money.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import type { Repositories } from '../../src/ports/Repositories.js';

const at = (s: number) => new Date(Date.UTC(2026, 2, 1, 10, 0, s));

export function describeRepositoryContract(name: string, create: () => Promise<Repositories>) {
  describe(`${name}: repository contract`, () => {
    const owner: OwnerId = asId('owner-1');

    const seed = async (repos: Repositories) => {
      await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
      const thread = await repos.threads.getOrCreateForOwner(owner, at(0));
      const session = new Session(newId(), thread.id, 'chat', at(1));
      await repos.sessions.insert(session);
      return { thread, session };
    };

    const message = (session: Session, text: string, s: number): Message => ({
      id: newId(),
      threadId: session.threadId,
      sessionId: session.id,
      role: 'user',
      author: 'owner',
      parts: [{ type: 'text', text }],
      channel: 'cli',
      withdrawn: false,
      createdAt: at(s),
    });

    const turn = (sessionId: SessionId, s: number) =>
      Turn.create({ id: newId(), sessionId, source: 'user', createdAt: at(s) });

    it('upserts and reads owners', async () => {
      const repos = await create();
      await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
      await repos.owners.upsert({
        id: owner,
        displayName: 'Samantha',
        timezone: 'Europe/Paris',
        locale: 'fr',
      });
      expect(await repos.owners.get(owner)).toEqual({
        id: owner,
        displayName: 'Samantha',
        timezone: 'Europe/Paris',
        locale: 'fr',
      });
      expect(await repos.owners.get(asId('missing'))).toBeUndefined();
    });

    it('creates one active thread per owner and returns it again', async () => {
      const repos = await create();
      await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
      const a = await repos.threads.getOrCreateForOwner(owner, at(0));
      const b = await repos.threads.getOrCreateForOwner(owner, at(5));
      expect(b.id).toBe(a.id);
      expect(b.status).toBe('active');
      expect((await repos.threads.get(a.id))!.createdAt).toEqual(at(0));
    });

    it('stores sessions and finds the main chat session', async () => {
      const repos = await create();
      const { thread, session } = await seed(repos);
      await repos.sessions.insert(new Session(newId(), thread.id, 'task', at(2)));
      await repos.sessions.insert(new Session(newId(), thread.id, 'chat', at(3)));
      expect((await repos.sessions.findMainChat(thread.id))!.id).toBe(session.id);
      expect((await repos.sessions.listByThread(thread.id)).map((s) => s.kind)).toEqual([
        'chat',
        'task',
        'chat',
      ]);
      const loaded = await repos.sessions.get(session.id);
      expect(loaded).toBeInstanceOf(Session);
      expect(loaded!.createdAt).toEqual(at(1));
    });

    it('appends messages and lists them oldest first, with a limit on the most recent', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      for (const [i, text] of ['one', 'two', 'three'].entries()) {
        await repos.messages.append(message(session, text, 10 + i));
      }
      const all = await repos.messages.listBySession(session.id);
      expect(all.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
        'one',
        'two',
        'three',
      ]);
      const recent = await repos.messages.listBySession(session.id, { limit: 2 });
      expect(recent.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['two', 'three']);
      expect(all[0]).toMatchObject({
        role: 'user',
        author: 'owner',
        channel: 'cli',
        withdrawn: false,
      });
      expect(all[0]!.createdAt).toEqual(at(10));
      expect(await repos.messages.get(all[1]!.id)).toEqual(all[1]);
    });

    it('keeps rich content parts intact', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const m: Message = {
        ...message(session, '', 10),
        role: 'assistant',
        author: 'assistant',
        parts: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'Result: ' },
          {
            type: 'tool_call',
            call: { id: asId('c1'), name: 'calculator', arguments: { expression: '1+1' } },
          },
          { type: 'tool_result', toolCallId: asId('c1'), content: '2', isError: false },
        ],
      };
      await repos.messages.append(m);
      expect((await repos.messages.get(m.id))!.parts).toEqual(m.parts);
    });

    it('updates a turn only when its stored status matches (compare-and-set)', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const t = turn(session.id, 20);
      await repos.turns.insert(t);

      const a = (await repos.turns.get(t.id))!;
      const b = (await repos.turns.get(t.id))!;
      a.start(at(21));
      b.start(at(22));
      expect(await repos.turns.update(a, 'queued')).toBe(true);
      expect(await repos.turns.update(b, 'queued')).toBe(false); // someone else already started it

      const stored = (await repos.turns.get(t.id))!;
      expect(stored.status).toBe('running');
      expect(stored.toProps().startedAt).toEqual(at(21));
    });

    it('lists turns by status and by session, oldest first', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const t1 = turn(session.id, 30);
      const t2 = turn(session.id, 31);
      await repos.turns.insert(t2);
      await repos.turns.insert(t1);
      t2.start(at(32));
      await repos.turns.update(t2, 'queued');
      expect((await repos.turns.listByStatus('queued')).map((t) => t.id)).toEqual([t1.id]);
      expect((await repos.turns.listByStatus('running')).map((t) => t.id)).toEqual([t2.id]);
      expect((await repos.turns.listBySession(session.id)).map((t) => t.id)).toEqual([
        t1.id,
        t2.id,
      ]);
    });

    it('commits a unit of work and rolls everything back when it throws', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const kept = message(session, 'kept', 40);
      await repos.uow.run(async (tx) => {
        await repos.messages.append(kept, tx);
        await repos.turns.insert(turn(session.id, 40), tx);
      });

      const lost = message(session, 'lost', 41);
      const lostTurn = turn(session.id, 41);
      await expect(
        repos.uow.run(async (tx) => {
          await repos.messages.append(lost, tx);
          await repos.turns.insert(lostTurn, tx);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await repos.messages.get(kept.id)).toBeDefined();
      expect(await repos.messages.get(lost.id)).toBeUndefined();
      expect(await repos.turns.get(lostTurn.id)).toBeUndefined();
    });

    it('appends turn events in order', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const t = turn(session.id, 50);
      await repos.turns.insert(t);
      await repos.turnEvents.append({
        turnId: t.id,
        kind: 'model_call',
        data: { n: 1 },
        at: at(51),
      });
      await repos.turnEvents.append({
        turnId: t.id,
        kind: 'tool_start',
        data: { n: 2 },
        at: at(52),
      });
      const events = await repos.turnEvents.listByTurn(t.id);
      expect(events.map((e) => [e.kind, e.data.n])).toEqual([
        ['model_call', 1],
        ['tool_start', 2],
      ]);
      expect(events[0]!.at).toEqual(at(51));
    });

    it('records usage with and without a known cost, and lists it by time', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const t = turn(session.id, 70);
      await repos.turns.insert(t);
      await repos.usage.append({
        ownerId: owner,
        turnId: t.id,
        purpose: 'chat',
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        inputTokens: 1200,
        outputTokens: 80,
        cachedInputTokens: 1000,
        reasoningTokens: 20,
        cost: Money.fromMicros(345, 'USD'),
        at: at(71),
      });
      await repos.usage.append({
        ownerId: owner,
        provider: 'local',
        model: 'qwen3:4b',
        inputTokens: 50,
        outputTokens: 5,
        at: at(72),
      });
      const rows = await repos.usage.listSince(owner, at(71));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ turnId: t.id, purpose: 'chat', cachedInputTokens: 1000 });
      expect(rows[0]!.cost!.micros).toBe(345);
      expect(rows[0]!.at).toEqual(at(71));
      expect(rows[1]!.cost).toBeUndefined();
      expect(await repos.usage.listSince(owner, at(72))).toHaveLength(1);
    });

    it('rejects duplicate ids', async () => {
      const repos = await create();
      const { session } = await seed(repos);
      const m = message(session, 'x', 60);
      await repos.messages.append(m);
      await expect(repos.messages.append(m)).rejects.toThrow();
      await expect(repos.sessions.insert(session)).rejects.toThrow();
    });
  });
}
