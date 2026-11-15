import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { OwnerKeyFile } from '../../src/adapters/auth/OwnerKeyFile.js';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { SoulService } from '../../src/application/soul/SoulService.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { startApiServer, type RunningApi } from '../../src/composition/apiServer.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import type { LiveEvent } from '../../src/interfaces/http/contract.js';
import { ApiClient, ApiError } from '../../src/interfaces/tui/ApiClient.js';
import { BaseTool, type ToolOutput } from '../../src/ports/Tool.js';
import { routerFor, ScriptedProvider, testServices, until } from '../helpers.js';

class HangTool extends BaseTool<z.ZodObject<Record<string, never>>> {
  readonly name = 'test.hang';
  readonly description = 'Never finishes';
  readonly input = z.object({});
  readonly effect = 'read' as const;
  started = 0;
  async run(): Promise<ToolOutput> {
    this.started++;
    return new Promise(() => {});
  }
}

let running: RunningApi | undefined;
let dir: string | undefined;
afterEach(async () => {
  await running?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(replies: ConstructorParameters<typeof ScriptedProvider>[0]) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-api-'));
  const keys = new OwnerKeyFile(dir);
  const { created } = await keys.ensure();
  const services = testServices();
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const hang = new HangTool();
  const tools = new ToolCatalog([hang]);
  const ownerId = asId<OwnerId>('owner');
  await repos.owners.upsert({ id: ownerId, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
  const soul = new SoulService({
    store: repos.soul,
    uow: repos.uow,
    ownerId,
    clock: services.clock,
    log: services.log,
    dataDir: dir,
  });
  await soul.start();
  const agent = new Agent({
    name: 'Test',
    ownerId,
    models: routerFor(new ScriptedProvider(replies)),
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
  running = await startApiServer(
    { agent, repos, ...services, ownerId, soul, verifyKey: (k) => keys.verify(k) },
    { host: '127.0.0.1', port: 0 },
  );
  return { client: new ApiClient(running.url, created!), url: running.url, keys, hang, dir };
}

describe('OwnerKeyFile (decision Q3)', () => {
  it('creates a key once, keeps only its hash for checking, and verifies in constant time', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-key-'));
    const first = await new OwnerKeyFile(dir).ensure();
    expect(first.created).toMatch(/^shk_[A-Za-z0-9_-]{43}$/);
    const again = new OwnerKeyFile(dir);
    expect((await again.ensure()).created).toBeUndefined();
    expect(again.verify(first.created)).toBe(true);
    expect(again.verify('shk_wrong')).toBe(false);
    expect(again.verify(undefined)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'owner-key.sha256'), 'utf8')).not.toContain(
      first.created!,
    );
  });
});

describe('API over a real server, with the TUI client', () => {
  it('sends a message and streams the reply over the WebSocket', async () => {
    const { client } = await serve([{ content: 'Good evening, sir.' }]);
    expect(await client.health()).toBe(true);
    const events: LiveEvent[] = [];
    const close = await client.events((e) => events.push(e));
    const { turnId } = await client.send('Hello');
    await until(
      () => events.some((e) => e.type === 'turn.status' && e.status === 'succeeded'),
      5000,
    );
    close();
    expect(
      events
        .filter((e) => e.turnId === turnId)
        .map((e) => (e.type === 'turn.status' ? e.status : e.type)),
    ).toEqual(['queued', 'running', 'turn.text_delta', 'succeeded']);
    const done = events.find((e) => e.type === 'turn.status' && e.status === 'succeeded');
    expect(done).toMatchObject({ reply: 'Good evening, sir.' });
    expect(JSON.stringify(events)).not.toContain('replyChannel');
    const history = await client.history();
    expect(history.messages.map((m) => m.text)).toEqual(['Hello', 'Good evening, sir.']);
  });

  it('stops a running turn through the API', async () => {
    const { client, hang } = await serve([
      { toolCalls: [{ id: 'c1', name: 'test.hang', arguments: {} }] },
    ]);
    const { turnId } = await client.send('Do the slow thing');
    await until(() => hang.started === 1, 5000);
    expect(await client.stop(turnId)).toBe(true);
    await until(async () => (await client.turn(turnId)).status === 'cancelled', 5000).catch(
      () => undefined,
    );
    expect((await client.turn(turnId)).status).toBe('cancelled');
  });

  it('refuses a wrong key, and a WebSocket without a valid single-use ticket', async () => {
    const { url, client } = await serve([]);
    await expect(new ApiClient(url, 'shk_wrong').history()).rejects.toMatchObject({ status: 401 });
    const refused = await fetch(`${url}/api/events?ticket=made-up`);
    expect(refused.status).toBe(401);
    // A ticket works once.
    const close = await client.events(() => {});
    close();
    await expect(new ApiClient(url, 'shk_wrong').events(() => {})).rejects.toBeInstanceOf(ApiError);
  });

  it('starts a new session and keeps histories apart', async () => {
    const { client } = await serve([{ content: 'one' }, { content: 'two' }]);
    await client.send('in main');
    const other = await client.newSession();
    await client.send('in other', other);
    await until(async () => (await client.history(other)).messages.length === 2, 5000);
    expect((await client.history(other)).messages.map((m) => m.text)).toEqual(['in other', 'two']);
    expect((await client.history('main')).messages[0]!.text).toBe('in main');
  });
});
