import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { createShitsuji, OWNER_ID } from '../../src/composition/createShitsuji.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { loadPluginsFromDirectory } from '../../src/composition/loadPluginsFromDirectory.js';
import type { ShitsujiPlugin } from '../../src/ports/Plugin.js';
import { BaseTool, type ToolOutput } from '../../src/ports/Tool.js';
import { Turn } from '../../src/domain/model/Turn.js';
import { SandboxUnavailable } from '../../src/domain/errors.js';
import { asId, type SessionId, type TurnId } from '../../src/domain/model/ids.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { ScriptedProvider, TestChannel, testServices, until } from '../helpers.js';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-root-'));
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const judgeFixture = (name: string) =>
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/trust', name),
    'utf8',
  );

/** A model that never answers unless the turn is stopped, so /stop lands while it runs (#68). */
class HangingProvider implements ModelProvider {
  readonly id = 'fake';
  async *stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    yield { type: 'done', finishReason: 'stop' };
  }
  async listModels() {
    return ['test-model'];
  }
}

/** A tool with an outside effect, to exercise the trust judge (S35). */
class MailTool extends BaseTool<z.ZodObject<{ to: z.ZodString }>> {
  readonly name = 'test.mail';
  readonly description = 'Sends an email';
  readonly input = z.object({ to: z.string() });
  readonly effect = 'external' as const;
  async run(): Promise<ToolOutput> {
    return { content: 'sent' };
  }
}

const config = (extra: Record<string, unknown> = {}) =>
  shitsujiConfigSchema.parse({
    paths: { dataDir },
    channels: { webhook: { enabled: false } },
    api: { enabled: false },
    models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/test-model' } },
    ...extra,
  });

const fakes = (replies: string[]) => {
  const provider = new ScriptedProvider(
    replies.map((content) => ({ content })),
    'fake',
  );
  const channel = new TestChannel();
  const plugin: ShitsujiPlugin = {
    manifest: { id: 'test.fakes', name: 'fakes', version: '1', provides: ['model', 'channel'] },
    register(ctx) {
      ctx.addModelProvider(provider);
      ctx.addChannel(channel);
    },
  };
  return { provider, channel, plugin };
};

describe('createShitsuji', () => {
  it('wires channels to the agent: a message in gets a reply out', async () => {
    const { provider, channel, plugin } = fakes(['Good evening.']);
    const shitsuji = await createShitsuji(config(), {
      services: testServices(),
      plugins: [plugin],
    });
    await shitsuji.start();

    channel.receive('Hello', 'chat-42');
    await until(() => channel.sent.length > 0);

    expect(channel.sent).toEqual([{ destination: 'chat-42', message: 'Good evening.' }]);
    expect(channel.typingCalls).toEqual(['chat-42']);
    expect(provider.requests[0]!.model).toBe('test-model');
    await shitsuji.stop();
    expect(channel.stopped).toBe(1);
  });

  it('refuses a sandbox driver this build does not have yet (#70)', async () => {
    const { plugin } = fakes([]);

    await expect(
      createShitsuji(config({ sandbox: { driver: 'shitsuji' } }), {
        services: testServices(),
        plugins: [plugin],
      }),
    ).rejects.toThrow(SandboxUnavailable);
  });

  it('shows only "Stopped." when the owner stops a turn (#68)', async () => {
    const channel = new TestChannel();
    const plugin: ShitsujiPlugin = {
      manifest: { id: 'test.slow', name: 'slow', version: '1', provides: ['model', 'channel'] },
      register(ctx) {
        ctx.addModelProvider(new HangingProvider());
        ctx.addChannel(channel);
      },
    };
    const shitsuji = await createShitsuji(config(), {
      services: testServices(),
      plugins: [plugin],
    });
    await shitsuji.start();

    channel.receive('What is the weather?', 'chat-42');
    await until(() => channel.typingCalls.length > 0);

    channel.receive('/stop', 'chat-42');
    await until(() => channel.sent.length > 0);
    // Give a second reply the chance to arrive before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A stop the owner asked for is not an error: '/stop' answers "Stopped.", and the cancelled
    // turn must not also send "Error: stopped by owner".
    expect(channel.sent.map((s) => s.message)).toEqual(['Stopped.']);
    await shitsuji.stop();
  });

  it('meters every model call: one usage row, priced from models.catalog', async () => {
    const { plugin, channel } = fakes(['Done.']);
    const repos = new InMemoryRepositories();
    const shitsuji = await createShitsuji(
      config({
        models: {
          providers: { fake: { kind: 'plugin' } },
          purposes: { chat: 'fake/test-model' },
          catalog: {
            'fake/test-model': {
              capabilities: ['tools'],
              price: { inputPerMTok: 1, outputPerMTok: 2 },
            },
          },
        },
      }),
      { services: testServices(), plugins: [plugin], repos },
    );
    await shitsuji.start();
    channel.receive('Hello');
    await until(() => channel.sent.length > 0);
    const rows = await repos.usage.listSince(OWNER_ID, new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'fake', model: 'test-model', purpose: 'chat' });
    expect(rows[0]!.turnId).toBeDefined();
    expect(rows[0]!.cost!.micros).toBe(20); // 10 in × $1/M + 5 out × $2/M
    await shitsuji.stop();
  });

  it('sends a file a tool attached as a file part of the reply (S33)', async () => {
    fs.mkdirSync(path.join(dataDir, 'handoff'), { recursive: true });
    const file = path.join(dataDir, 'handoff', 'report.pdf');
    fs.writeFileSync(file, 'pdf');
    const provider = new ScriptedProvider(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'workspace.send', arguments: { path: file, caption: 'The report' } },
          ],
        },
        { content: 'Here is the report.' },
      ],
      'fake',
    );
    const channel = new TestChannel();
    const plugin: ShitsujiPlugin = {
      manifest: { id: 'test.fakes', name: 'fakes', version: '1', provides: ['model', 'channel'] },
      register(ctx) {
        ctx.addModelProvider(provider);
        ctx.addChannel(channel);
      },
    };
    const services = testServices();
    const shitsuji = await createShitsuji(config(), {
      services,
      plugins: [plugin],
    });
    await shitsuji.start();

    channel.receive('Send me the report', 'chat-42');
    await until(() => channel.sent.length > 0);

    expect(channel.sent[0]!.message).toContain('Here is the report.');
    expect(channel.delivered[0]!.parts).toEqual([
      { kind: 'text', markdown: 'Here is the report.' },
      {
        kind: 'file',
        fileRef: { name: 'report.pdf', path: file, mediaType: 'application/pdf' },
        caption: 'The report',
      },
    ]);
    await shitsuji.stop();
  });

  it("runs an outside action the judge allows with the owner's quote (S35)", async () => {
    const provider = new ScriptedProvider(
      [
        { toolCalls: [{ id: 'c1', name: 'test.mail', arguments: { to: 'anna@example.com' } }] },
        { content: judgeFixture('judge-allow.json') },
        { content: 'The report is on its way.' },
      ],
      'fake',
    );
    const channel = new TestChannel();
    const plugin: ShitsujiPlugin = {
      manifest: {
        id: 'test.mailer',
        name: 'mailer',
        version: '1',
        provides: ['model', 'channel', 'tools'],
      },
      register(ctx) {
        ctx.addModelProvider(provider);
        ctx.addChannel(channel);
        ctx.addTools([new MailTool()]);
      },
    };
    const repos = new InMemoryRepositories();
    const shitsuji = await createShitsuji(config(), {
      services: testServices(),
      plugins: [plugin],
      repos,
    });
    await shitsuji.start();

    channel.receive('Email Anna the quarterly report.', 'chat-42');
    await until(() => channel.sent.length > 0);

    expect(channel.sent[0]!.message).toBe('The report is on its way.');
    const receipts = await repos.turnEvents.listRecent(OWNER_ID, {
      kinds: ['tool_end'],
      limit: 1,
    });
    expect(receipts[0]!.data).toMatchObject({
      tool: 'test.mail',
      outcome: 'ok',
      allowedBy: { kind: 'quote', detail: 'Email Anna the quarterly report' },
    });
    await shitsuji.stop();
  });

  it('replies with the error instead of staying silent when the model fails', async () => {
    const { channel, plugin } = fakes([]); // no scripted reply: the model call throws
    const services = testServices();
    const shitsuji = await createShitsuji(config(), { services, plugins: [plugin] });
    await shitsuji.start();
    channel.receive('Hello');
    await until(() => channel.sent.length > 0);
    expect(channel.sent[0]!.message).toBe('Error: No scripted reply left');
    expect(services.log.records.some((r) => r.message === 'Turn failed')).toBe(true);
    await shitsuji.stop();
  });

  it('registers the built-in tools, and no channels when channels are turned off', async () => {
    const { plugin } = fakes([]);
    const shitsuji = await createShitsuji(config({ channels: {} }), {
      services: testServices(),
      plugins: [plugin],
      channels: false,
    });
    expect(shitsuji.agent.getTools().map((t) => t.name)).toContain('math.evaluate');
    await shitsuji.start();
    await shitsuji.stop();
  });

  it('lets a channel ask the gateway which chats may store files (#44)', async () => {
    const channel = new TestChannel(true);
    const plugin: ShitsujiPlugin = {
      manifest: { id: 'test.probe', name: 'probe', version: '1', provides: ['model', 'channel'] },
      register(ctx) {
        ctx.addModelProvider(new ScriptedProvider([], 'fake'));
        ctx.addChannel(channel);
      },
    };
    const shitsuji = await createShitsuji(config(), {
      services: testServices(),
      plugins: [plugin],
    });
    await shitsuji.start();

    expect(await channel.accepted('chat-1')).toBe(false);

    await shitsuji.stop();
  });

  it('refuses Telegram enabled without a token (S32)', async () => {
    await expect(
      createShitsuji(config({ channels: { telegram: { enabled: true } } }), {
        services: testServices(),
      }),
    ).rejects.toThrow(/channels\.telegram\.token/);
  });

  it('fails clearly when no plugin registers the chat provider', async () => {
    await expect(createShitsuji(config(), { services: testServices() })).rejects.toThrow(
      /models\.purposes\.chat: .*uses provider "fake", which is not registered/,
    );
  });

  it('builds OpenAI-compatible providers from the config without any network call', async () => {
    const shitsuji = await createShitsuji(
      config({
        models: {
          providers: { deepseek: { kind: 'openai-compatible', apiKey: 'k' } },
          purposes: { chat: 'deepseek/deepseek-flash' },
        },
      }),
      { services: testServices() },
    );
    expect(shitsuji.agent).toBeDefined();
  });
});

describe('loadPluginsFromDirectory', () => {
  it('loads default-exported plugins and plugin factories, in name order', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'b.mjs'),
      `export default () => ({ manifest: { id: 'ext.b', name: 'B', version: '1', provides: [] }, register() {} });`,
    );
    fs.mkdirSync(path.join(dataDir, 'a'));
    fs.writeFileSync(
      path.join(dataDir, 'a', 'index.js'),
      `export default { manifest: { id: 'ext.a', name: 'A', version: '1', provides: [] }, register() {} };`,
    );
    fs.writeFileSync(path.join(dataDir, 'README.md'), 'ignored');
    const plugins = await loadPluginsFromDirectory(dataDir, testServices().log);
    expect(plugins.map((p) => p.manifest.id)).toEqual(['ext.a', 'ext.b']);
  });

  it('rejects files that are not plugins or have a bad manifest', async () => {
    fs.writeFileSync(path.join(dataDir, 'x.mjs'), `export default 42;`);
    await expect(loadPluginsFromDirectory(dataDir, testServices().log)).rejects.toThrow(
      /must default-export a plugin/,
    );
    fs.rmSync(path.join(dataDir, 'x.mjs')); // Node caches modules by path, so use a new name
    fs.writeFileSync(
      path.join(dataDir, 'y.mjs'),
      `export default { manifest: { id: 'Bad Id', name: 'x', version: '1', provides: ['magic'] }, register() {} };`,
    );
    await expect(loadPluginsFromDirectory(dataDir, testServices().log)).rejects.toThrow(
      /invalid manifest: id .*; provides\.0/,
    );
  });

  it('returns nothing and warns when the folder does not exist', async () => {
    const services = testServices();
    expect(await loadPluginsFromDirectory(path.join(dataDir, 'nope'), services.log)).toEqual([]);
    expect(services.log.records[0]!.level).toBe('warn');
  });
});

it('registers test.notify only when a mock service is configured (S36)', async () => {
  const { plugin } = fakes([]);
  const shitsuji = await createShitsuji(
    config({ tools: { notifyUrl: 'http://127.0.0.1:9999/notify' } }),
    { services: testServices(), plugins: [plugin] },
  );
  expect(shitsuji.agent.getTools().map((t) => t.name)).toContain('test.notify');

  const without = await createShitsuji(config(), {
    services: testServices(),
    plugins: [fakes([]).plugin],
  });
  expect(without.agent.getTools().map((t) => t.name)).not.toContain('test.notify');
});

it("sends an approval card to the turn's channel (S37)", async () => {
  const { channel, plugin } = fakes(['ok']);
  const repos = new InMemoryRepositories();
  const shitsuji = await createShitsuji(config(), {
    services: testServices(),
    plugins: [plugin],
    repos,
  });
  await shitsuji.start();

  const turn = Turn.create({
    id: asId<TurnId>('turn-9'),
    sessionId: asId<SessionId>('s-1'),
    source: 'user',
    replyChannel: 'test:chat-42',
    createdAt: new Date(),
  });
  turn.start(new Date());
  await repos.turns.insert(turn);

  shitsuji.events.publish('approval.requested', {
    approvalId: 'a1',
    turnId: 'turn-9',
    sessionId: 's-1',
    tool: 'test.notify',
    effect: 'external',
    summary: 'test.notify (external)',
    actionHash: 'h'.repeat(64),
  });

  await until(() => channel.delivered.length > 0);
  expect(channel.delivered[0]!.parts).toEqual([
    {
      kind: 'approval',
      approvalId: 'a1',
      summary: 'test.notify (external)',
      actionLabel: 'Approve',
    },
  ]);
  expect(channel.delivered[0]!.intent).toBe('question');
  await shitsuji.stop();
});

it('exposes the approval service for the evaluation harness (S38)', async () => {
  const { plugin } = fakes([]);
  const shitsuji = await createShitsuji(config(), {
    services: testServices(),
    plugins: [plugin],
  });

  expect(shitsuji.approvals).toBeDefined();
  expect(typeof shitsuji.approvals?.resolve).toBe('function');
});
