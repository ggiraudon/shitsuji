import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { NodeTextFile } from '../../src/adapters/files/NodeTextFile.js';
import { SoulService } from '../../src/application/soul/SoulService.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { createApi } from '../../src/interfaces/http/createApi.js';
import { routerFor, ScriptedProvider, testServices } from '../helpers.js';

async function setup(options: { dataDir?: string } = {}) {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const tools = new ToolCatalog();
  const ownerId = asId<OwnerId>('owner');
  await repos.owners.upsert({
    id: ownerId,
    displayName: 'Jeanne',
    timezone: 'UTC',
    locale: 'en',
  });
  const soul = new SoulService({
    store: repos.soul,
    uow: repos.uow,
    ownerId,
    clock: services.clock,
    log: services.log,
    ...(options.dataDir && { file: new NodeTextFile(path.join(options.dataDir, 'SOUL.md')) }),
  });
  await soul.start();
  const agent = new Agent({
    name: 'Test',
    ownerId,
    models: routerFor(new ScriptedProvider([{ content: 'Hi there.' }])),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    jobs,
    soul,
    ...services,
  });
  await jobs.start();
  await agent.start();
  const app = createApi({
    agent,
    repos,
    ...services,
    ownerId,
    soul,
    verifyKey: (k) => k === 'secret',
  });
  return { app, agent, soul };
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };

describe('HTTP API', () => {
  it('answers health without a key and refuses everything else without the right key', async () => {
    const { app } = await setup();
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/turns/x')).status).toBe(401);
    expect(
      (await app.request('/api/turns/x', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
  });

  it('accepts a message, runs the turn, and returns the history', async () => {
    const { app, agent } = await setup();
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'Hello' }),
    });
    expect(res.status).toBe(202);
    const { turnId } = (await res.json()) as { turnId: string };
    const status = async () =>
      (
        (await (await app.request(`/api/turns/${turnId}`, { headers: auth })).json()) as {
          status: string;
        }
      ).status;
    for (let i = 0; i < 100 && (await status()) !== 'succeeded'; i++)
      await new Promise((r) => setTimeout(r, 10));
    await agent.idle();
    expect(await status()).toBe('succeeded');
    const history = (await (
      await app.request('/api/sessions/main/messages', { headers: auth })
    ).json()) as {
      messages: { author: string; text: string }[];
    };
    expect(history.messages.map((m) => `${m.author}:${m.text}`)).toEqual([
      'owner:Hello',
      'assistant:Hi there.',
    ]);
  });

  it('rejects an invalid body', async () => {
    const { app } = await setup();
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('shows the SOUL and turns an edit of SOUL.md into a revision once confirmed', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shitsuji-api-soul-'));
    try {
      const { app } = await setup({ dataDir });
      const initial = (await (await app.request('/api/soul', { headers: auth })).json()) as {
        revision: number;
        body: string;
        pending?: unknown;
      };
      expect(initial.revision).toBe(1);
      expect(initial.body).toContain('Shitsuji');
      expect(initial.pending).toBeUndefined();

      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'New standing instructions.\n', 'utf8');
      const edited = (await (await app.request('/api/soul', { headers: auth })).json()) as {
        pending?: { proposed: string; hash: string };
      };
      expect(edited.pending?.proposed).toBe('New standing instructions.');
      const confirm = (hash?: string) =>
        app.request('/api/soul/confirm', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(hash ? { hash } : {}),
        });

      // Without the reviewed hash, nothing is applied.
      expect((await confirm()).status).toBe(400);
      // Edited again after the review: a conflict, and the newer text is not applied.
      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Unreviewed text.\n', 'utf8');
      expect((await confirm(edited.pending!.hash)).status).toBe(409);
      // Back to the reviewed text, saved with Windows line endings: still the same edit.
      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'New standing instructions.\r\n', 'utf8');

      const confirmed = await confirm(edited.pending!.hash);
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ revision: 2 });

      // Nothing left to apply: a conflict, not a server error.
      const again = await confirm(edited.pending!.hash);
      expect(again.status).toBe(409);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
