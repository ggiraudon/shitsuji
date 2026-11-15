import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { INTERRUPTED, StartupRecovery } from '../../src/application/StartupRecovery.js';
import { asId, newId, type OwnerId } from '../../src/domain/model/ids.js';
import { textOf } from '../../src/domain/model/Message.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import { testServices } from '../helpers.js';

const owner: OwnerId = asId('owner');

async function withTurns(...statuses: ('queued' | 'running' | 'succeeded')[]) {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({ id: owner, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
  const thread = await repos.threads.getOrCreateForOwner(owner, new Date());
  const session = new Session(newId(), thread.id, 'chat', new Date());
  await repos.sessions.insert(session);
  const turns: Turn[] = [];
  for (const status of statuses) {
    const turn = Turn.create({
      id: newId(),
      sessionId: session.id,
      source: 'user',
      createdAt: new Date(),
    });
    if (status !== 'queued') turn.start(new Date());
    if (status === 'succeeded') turn.succeed(new Date());
    await repos.turns.insert(turn);
    turns.push(turn);
  }
  return { repos, session, turns };
}

describe('StartupRecovery', () => {
  it('fails running turns as interrupted and tells the session, leaving other turns alone', async () => {
    const { repos, session, turns } = await withTurns('running', 'queued', 'succeeded');
    const services = testServices();

    const recovered = await new StartupRecovery(repos, services.clock, services.log).run();

    expect(recovered.map((t) => t.id)).toEqual([turns[0]!.id]);
    expect((await repos.turns.get(turns[0]!.id))!.toProps()).toMatchObject({
      status: 'failed',
      error: INTERRUPTED,
    });
    expect((await repos.turns.get(turns[1]!.id))!.status).toBe('queued');
    expect((await repos.turns.get(turns[2]!.id))!.status).toBe('succeeded');
    const [note] = await repos.messages.listBySession(session.id);
    expect(note).toMatchObject({ role: 'system', author: 'system', turnId: turns[0]!.id });
    expect(textOf(note!)).toMatch(/interrupted by a restart/);
    expect(services.log.records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('does nothing when no turn was running', async () => {
    const { repos } = await withTurns('queued', 'succeeded');
    const services = testServices();
    expect(await new StartupRecovery(repos, services.clock, services.log).run()).toEqual([]);
    expect(services.log.records).toEqual([]);
  });
});

describe('InMemoryJobQueue', () => {
  const queue = () => {
    const services = testServices();
    return { services, jobs: new InMemoryJobQueue(services.log, services.clock) };
  };

  it('runs enqueued jobs with their data', async () => {
    const { jobs } = queue();
    const seen: unknown[] = [];
    await jobs.work<{ n: number }>('count', async (job) => void seen.push(job.data.n));
    await jobs.start();
    await jobs.enqueue('count', { n: 1 });
    await jobs.enqueue('count', { n: 2 });
    await jobs.drain();
    expect(seen).toEqual([1, 2]);
    await jobs.stop();
  });

  it('keeps one queued job per singletonKey', async () => {
    const { jobs } = queue();
    expect(await jobs.enqueue('drain', { s: 1 }, { singletonKey: 'session-1' })).toEqual(
      expect.any(String),
    );
    expect(await jobs.enqueue('drain', { s: 1 }, { singletonKey: 'session-1' })).toBeNull();
  });

  it('waits for startAfter', async () => {
    const { jobs, services } = queue();
    const seen: string[] = [];
    await jobs.work('later', async () => void seen.push('ran'));
    await jobs.start();
    services.clock.set('2026-01-01T00:00:00Z');
    await jobs.enqueue('later', {}, { startAfter: new Date('2026-01-01T01:00:00Z') });
    await jobs.drain();
    expect(seen).toEqual([]);
    services.clock.set('2026-01-01T01:00:00Z');
    await jobs.enqueue('nudge', {}); // any enqueue re-checks the queue
    await jobs.drain();
    expect(seen).toEqual(['ran']);
    await jobs.stop();
  });

  it('retries a failing job up to its limit, logging each failure', async () => {
    const { jobs, services } = queue();
    let attempts = 0;
    await jobs.work('flaky', async () => {
      attempts++;
      throw new Error('down');
    });
    await jobs.start();
    await jobs.enqueue('flaky', {}, { retryLimit: 2 });
    await jobs.drain();
    expect(attempts).toBe(3);
    expect(services.log.records.filter((r) => r.message === 'Job failed')).toHaveLength(3);
    await jobs.stop();
  });
});
