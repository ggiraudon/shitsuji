import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { createApi } from '../../src/interfaces/http/createApi.js';
import { routerFor, ScriptedProvider, testServices } from '../helpers.js';

async function setup() {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const tools = new ToolCatalog();
  const ownerId = asId<OwnerId>('owner');
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
    ...services,
  });
  await jobs.start();
  await agent.start();
  const app = createApi({ agent, repos, ...services, ownerId, verifyKey: (k) => k === 'secret' });
  return { app, agent };
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
});
