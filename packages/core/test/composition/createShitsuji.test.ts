import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { createShitsuji, OWNER_ID } from '../../src/composition/createShitsuji.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { loadPluginsFromDirectory } from '../../src/composition/loadPluginsFromDirectory.js';
import type { ShitsujiPlugin } from '../../src/ports/Plugin.js';
import { ScriptedProvider, TestChannel, testServices, until } from '../helpers.js';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-root-'));
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const config = (extra: Record<string, unknown> = {}) =>
  shitsujiConfigSchema.parse({
    paths: { dataDir },
    channels: { cli: { enabled: false }, webhook: { enabled: false } },
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
    expect(provider.requests[0]!.model).toBe('test-model');
    await shitsuji.stop();
    expect(channel.stopped).toBe(1);
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

  it('replies with the error instead of staying silent when the model fails', async () => {
    const { channel, plugin } = fakes([]); // no scripted reply: the model call throws
    const services = testServices();
    const shitsuji = await createShitsuji(config(), { services, plugins: [plugin] });
    await shitsuji.start();
    channel.receive('Hello');
    await until(() => channel.sent.length > 0);
    expect(channel.sent[0]!.message).toBe('Error: No scripted reply left');
    expect(services.log.records.some((r) => r.message === 'Message failed')).toBe(true);
    await shitsuji.stop();
  });

  it('registers the built-in tools, and no channels when channels are turned off', async () => {
    const { plugin } = fakes([]);
    const shitsuji = await createShitsuji(config({ channels: {} }), {
      services: testServices(),
      plugins: [plugin],
      channels: false,
    });
    expect(shitsuji.agent.getTools().map((t) => t.name)).toContain('calculator');
    await shitsuji.start();
    await shitsuji.stop();
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
          purposes: { chat: 'deepseek/deepseek-v4.1-flash' },
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
