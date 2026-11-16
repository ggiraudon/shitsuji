import { describe, expect, it, vi } from 'vitest';
import { PluginError, PluginManager } from '../../src/application/PluginManager.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import type {
  PluginCapability,
  PluginRegistrationContext,
  ShitsujiPlugin,
} from '../../src/ports/Plugin.js';
import { ScriptedProvider, TestChannel, testServices } from '../helpers.js';

const plugin = (
  id: string,
  provides: PluginCapability[],
  register: (ctx: PluginRegistrationContext) => void,
  dispose?: () => void,
): ShitsujiPlugin => ({
  manifest: { id, name: id, version: '1.0.0', provides },
  register,
  dispose,
});

const manager = (settings = {}) => {
  const services = testServices();
  return { services, plugins: new PluginManager({ ...services, settings }) };
};

describe('PluginManager', () => {
  it('collects what plugins register', async () => {
    const { plugins } = manager();
    const provider = new ScriptedProvider([], 'deepseek');
    const channel = new TestChannel();
    await plugins.load([
      plugin('models', ['model'], (ctx) => ctx.addModelProvider(provider)),
      plugin('chan', ['channel'], (ctx) => ctx.addChannel(channel)),
      plugin('tools', ['tools'], (ctx) => ctx.addTools([new MathEvaluateTool()])),
    ]);
    expect(plugins.providers().get('deepseek')).toBe(provider);
    expect(plugins.channels()).toEqual([channel]);
    expect(plugins.tools().map((t) => t.name)).toEqual(['math.evaluate']);
    expect(plugins.plugins().map((p) => p.manifest.id)).toEqual(['models', 'chan', 'tools']);
  });

  it('gives each plugin only its own settings and a logger tagged with its id', async () => {
    const { plugins, services } = manager({ a: { token: 'x' } });
    const seen: Record<string, unknown>[] = [];
    await plugins.load([
      plugin('a', [], (ctx) => {
        seen.push(ctx.config);
        ctx.log.info('hello');
      }),
      plugin('b', [], (ctx) => void seen.push(ctx.config)),
    ]);
    expect(seen).toEqual([{ token: 'x' }, {}]);
    expect(services.log.records.find((r) => r.message === 'hello')?.context).toEqual({
      plugin: 'a',
    });
  });

  it('refuses registrations the manifest does not declare', async () => {
    const { plugins } = manager();
    await expect(
      plugins.load([plugin('sneaky', ['tools'], (ctx) => ctx.addChannel(new TestChannel()))]),
    ).rejects.toThrow(/registered channel "test" but its manifest does not provide "channel"/);
  });

  it('refuses duplicate plugin ids and duplicate names across plugins', async () => {
    const { plugins } = manager();
    await plugins.load([plugin('a', ['tools'], (ctx) => ctx.addTools([new MathEvaluateTool()]))]);
    await expect(plugins.load([plugin('a', [], () => {})])).rejects.toThrow(/already loaded/);
    await expect(
      plugins.load([plugin('b', ['tools'], (ctx) => ctx.addTools([new MathEvaluateTool()]))]),
    ).rejects.toThrow(/tool "math.evaluate" is already registered by a/);
  });

  it('leaves nothing behind when register() fails', async () => {
    const { plugins } = manager();
    const failing = plugin('bad', ['tools', 'channel'], (ctx) => {
      ctx.addTools([new MathEvaluateTool()]);
      throw new Error('cannot reach service');
    });
    const error = await plugins.load([failing]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginError);
    expect((error as Error).message).toBe('Plugin bad: register() failed: cannot reach service');
    expect(plugins.tools()).toEqual([]);
    expect(plugins.plugins()).toEqual([]);
    // The name it tried to claim is free again.
    await plugins.load([
      plugin('good', ['tools'], (ctx) => ctx.addTools([new MathEvaluateTool()])),
    ]);
    expect(plugins.tools()).toHaveLength(1);
  });

  it('disposes in reverse order and keeps going when one dispose fails', async () => {
    const { plugins, services } = manager();
    const order: string[] = [];
    await plugins.load([
      plugin(
        'first',
        [],
        () => {},
        () => void order.push('first'),
      ),
      plugin(
        'second',
        [],
        () => {},
        () => {
          order.push('second');
          throw new Error('stuck');
        },
      ),
      plugin(
        'third',
        [],
        () => {},
        vi.fn(() => void order.push('third')),
      ),
    ]);
    await plugins.disposeAll();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(services.log.records.some((r) => r.message === 'Plugin dispose failed')).toBe(true);
  });
});
