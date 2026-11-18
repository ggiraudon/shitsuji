import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PgBossJobQueue } from '../../src/adapters/jobs/PgBossJobQueue.js';
import { NullLogger } from '../../src/adapters/logging/loggers.js';
import { PostgresRepositories } from '../../src/adapters/postgres/PostgresRepositories.js';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { createShitsuji } from '../../src/composition/createShitsuji.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import type { ModelProvider, ModelStreamEvent } from '../../src/ports/ModelProvider.js';
import type { ShitsujiPlugin } from '../../src/ports/Plugin.js';
import { ScriptedProvider, testServices, transcript, until } from '../helpers.js';
import { closeAll, freshDatabase } from './postgres.js';

const dataDirs: string[] = [];
const tempDataDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-int-'));
  dataDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  closeAll();
});

describe('PgBossJobQueue', () => {
  it('runs a job enqueued in a committed transaction, and drops one from a rolled-back one', async () => {
    const { database, url } = await freshDatabase();
    const repos = new PostgresRepositories(database.db);
    const jobs = new PgBossJobQueue(url, new NullLogger());
    await jobs.start();
    const seen: string[] = [];
    await jobs.work<{ label: string }>('test.job', async (job) => void seen.push(job.data.label));

    await repos.uow.run((tx) => jobs.enqueue('test.job', { label: 'committed' }, {}, tx));
    await expect(
      repos.uow.run(async (tx) => {
        await jobs.enqueue('test.job', { label: 'rolled back' }, {}, tx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    await until(() => seen.length > 0, 15_000);
    await new Promise((r) => setTimeout(r, 2_500)); // give the rolled-back job a chance to (not) appear
    expect(seen).toEqual(['committed']);
    await jobs.stop();
  });

  it('keeps one queued job per singletonKey', async () => {
    const { url } = await freshDatabase();
    const jobs = new PgBossJobQueue(url, new NullLogger());
    await jobs.start();
    const later = new Date(Date.now() + 60_000);
    expect(
      await jobs.enqueue('test.single', {}, { singletonKey: 's1', startAfter: later }),
    ).toBeTruthy();
    expect(
      await jobs.enqueue('test.single', {}, { singletonKey: 's1', startAfter: later }),
    ).toBeNull();
    expect(
      await jobs.enqueue('test.single', {}, { singletonKey: 's2', startAfter: later }),
    ).toBeTruthy();
    await expect(jobs.enqueue('test.single', {})).rejects.toThrow(/must always use a singletonKey/);
    await jobs.stop();
  });
});

/** A model whose first call never answers until released: the turn stays "running". */
class HangingProvider implements ModelProvider {
  readonly id = 'fake';
  calls = 0;
  private release?: () => void;
  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    await new Promise<void>((resolve) => (this.release = resolve));
    yield { type: 'text_delta', text: 'too late' };
    yield { type: 'done', finishReason: 'stop' };
  }
  async listModels() {
    return ['m'];
  }
  unblock() {
    this.release?.();
  }
}

const modelPlugin = (provider: ModelProvider): ShitsujiPlugin => ({
  manifest: { id: 'test.model', name: 'model', version: '1', provides: ['model'] },
  register: (ctx) => ctx.addModelProvider(provider),
});

describe('crash in the middle of a turn (F02)', () => {
  it('marks the turn failed(interrupted) on restart, the session continues, and the old run cannot write late', async () => {
    const { database, url } = await freshDatabase();
    const config = shitsujiConfigSchema.parse({
      database: { url },
      paths: { dataDir: tempDataDir() },
      sandbox: { probes: { enabled: false } },
      channels: { webhook: { enabled: false } },
      api: { enabled: false },
      models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/m' } },
    });
    const repos = new PostgresRepositories(database.db);
    const owner: OwnerId = asId('owner');

    // First process: a turn starts and hangs inside the model call. We then "crash" it by
    // abandoning it without stop(), exactly as a killed process leaves the turn row "running".
    const hanging = new HangingProvider();
    const crashed = await createShitsuji(config, {
      services: testServices(),
      plugins: [modelPlugin(hanging)],
    });
    await crashed.start();
    const zombie = crashed.agent.send('Book the table').catch((e: Error) => e);
    await until(() => hanging.calls === 1, 10_000);
    expect(await repos.turns.listByStatus('running')).toHaveLength(1);
    // A dead process takes its job workers with it.
    await crashed.jobs.stop();

    // Restart: a new process on the same database.
    const fresh = new ScriptedProvider(
      [{ content: 'Sorry about that. Shall I try again?' }],
      'fake',
    );
    const restarted = await createShitsuji(config, {
      services: testServices(),
      plugins: [modelPlugin(fresh)],
    });
    await restarted.start();

    const [interrupted] = await repos.turns.listByStatus('failed');
    expect(interrupted!.error).toBe('interrupted');
    const reply = await restarted.agent.send('Did it work?');
    expect(reply.reply).toBe('Sorry about that. Shall I try again?');
    const sent = transcript(fresh.requests[0]!).map((line) => line.slice(0, 47));
    expect(sent).toEqual([
      'user:Book the table',
      'system:Note: your previous turn was interrupted',
      'user:Did it work?',
    ]);

    // The abandoned run wakes up: its compare-and-set save fails, so it cannot overwrite the result.
    hanging.unblock();
    const outcome = await zombie;
    expect(outcome).toBeInstanceOf(Error);
    expect((await repos.turns.get(interrupted!.id))!.error).toBe('interrupted');
    expect(await repos.threads.getOrCreateForOwner(owner, new Date())).toBeDefined();

    await restarted.stop();
    await crashed.stop();
  });
});
