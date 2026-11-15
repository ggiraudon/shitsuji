import { describe, expect, it } from 'vitest';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import {
  MeteredModelProvider,
  RedactingModelProvider,
  RetryingModelProvider,
} from '../../src/application/models/decorators.js';
import { ModelCatalog, type ModelInfo } from '../../src/application/models/ModelCatalog.js';
import {
  ModelRouter,
  NoModelAvailable,
  type ModelRoutingConfig,
} from '../../src/application/models/ModelRouter.js';
import { complete } from '../../src/application/modelCalls.js';
import { ProviderError } from '../../src/domain/errors.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { Money } from '../../src/domain/model/Money.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { ScriptedProvider, testServices } from '../helpers.js';

const owner: OwnerId = asId('owner');
const ask = (text = 'hi'): Omit<ModelRequest, 'model'> => ({
  messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
});

/** Fails with the given errors first (before any output), then answers. */
class FlakyProvider implements ModelProvider {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly failures: Error[],
    private readonly failAfterOutput = false,
  ) {}
  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    const failure = this.failures.shift();
    if (failure && this.failAfterOutput) {
      yield { type: 'tool_call', call: { id: asId('c'), name: 'send_email', arguments: {} } };
      throw failure;
    }
    if (failure) throw failure;
    yield { type: 'text_delta', text: `ok from ${this.id}` };
    yield { type: 'done', finishReason: 'stop' };
  }
  async listModels() {
    return [];
  }
}

const transient = (retryAfterSeconds?: number) =>
  new ProviderError('deepseek', 'HTTP 503', true, retryAfterSeconds ? { retryAfterSeconds } : {});
const permanent = () => new ProviderError('deepseek', 'HTTP 401', false);

describe('ModelCatalog', () => {
  const catalog = new ModelCatalog([
    {
      ref: 'deepseek/flash',
      price: {
        inputPerMTok: Money.of(0.27),
        outputPerMTok: Money.of(1.1),
        cachedInputPerMTok: Money.of(0.07),
      },
    },
  ]);

  it('prices fresh input, cached input and output separately', () => {
    const cost = catalog.cost('deepseek/flash', {
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      outputTokens: 100_000,
    });
    // 400k fresh × 0.27 + 600k cached × 0.07 + 100k out × 1.10 = 0.108 + 0.042 + 0.11
    expect(cost!.toString()).toBe('0.26 USD');
  });

  it('returns undefined for a model without a price', () => {
    expect(catalog.cost('local/qwen', { inputTokens: 10, outputTokens: 1 })).toBeUndefined();
  });
});

describe('ModelRouter', () => {
  const setup = (config: Partial<ModelRoutingConfig>, models: ModelInfo[] = []) => {
    const services = testServices();
    const providers = new Map<string, ModelProvider>([
      ['deepseek', new ScriptedProvider([], 'deepseek')],
      ['local', new ScriptedProvider([], 'local')],
      ['openrouter', new ScriptedProvider([], 'openrouter')],
    ]);
    const router = new ModelRouter(
      providers,
      { purposes: {}, fallbacks: {}, ...config },
      new ModelCatalog(models),
      services.log,
    );
    return { router, services };
  };

  it('binds a purpose to its configured model', () => {
    const { router } = setup({ purposes: { chat: 'deepseek/flash', classify: 'local/qwen3:4b' } });
    expect(router.select('classify')).toMatchObject({
      purpose: 'classify',
      ref: 'local/qwen3:4b',
      model: 'qwen3:4b',
    });
    expect(router.select('classify').provider.id).toBe('local');
  });

  it('uses the chat model for purposes that are not configured', () => {
    const { router } = setup({ purposes: { chat: 'deepseek/flash' } });
    expect(router.select('summarize').ref).toBe('deepseek/flash');
  });

  it('switching a purpose to another model is a configuration change only (F03)', () => {
    const a = setup({ purposes: { chat: 'deepseek/flash' } }).router.select('chat');
    const b = setup({ purposes: { chat: 'openrouter/vendor/other-model' } }).router.select('chat');
    expect([a.provider.id, a.model]).toEqual(['deepseek', 'flash']);
    expect([b.provider.id, b.model]).toEqual(['openrouter', 'vendor/other-model']);
  });

  it('skips models that lack a needed capability, using the fallback', () => {
    const { router } = setup(
      { purposes: { vision: 'local/text-only' }, fallbacks: { vision: ['deepseek/flash'] } },
      [
        { ref: 'local/text-only', capabilities: new Set(['tools']) },
        { ref: 'deepseek/flash', capabilities: new Set(['tools', 'vision']) },
      ],
    );
    expect(router.select('vision', ['vision']).ref).toBe('deepseek/flash');
    expect(() => router.select('vision', ['audio'])).toThrow(NoModelAvailable);
  });

  it('allows models with unknown capabilities, warning once', () => {
    const { router, services } = setup({ purposes: { chat: 'deepseek/flash' } });
    router.select('chat', ['tools']);
    router.select('chat', ['tools']);
    expect(services.log.records.filter((r) => r.level === 'warn')).toHaveLength(1);
  });

  it('fails clearly for an unregistered provider or no chat model', () => {
    expect(() => setup({ purposes: { chat: 'ghost/x' } }).router.select('chat')).toThrow(
      /uses provider "ghost", which is not registered/,
    );
    expect(() => setup({}).router.select('chat')).toThrow(/set models.purposes.chat/);
  });

  it('falls back to the next model when a provider fails before any output', async () => {
    const services = testServices();
    const down = new FlakyProvider('deepseek', [permanent()]);
    const up = new FlakyProvider('openrouter', []);
    const router = new ModelRouter(
      new Map<string, ModelProvider>([
        ['deepseek', down],
        ['openrouter', up],
      ]),
      { purposes: { chat: 'deepseek/flash' }, fallbacks: { chat: ['openrouter/backup'] } },
      new ModelCatalog(),
      services.log,
    );
    const { response, binding } = await router.complete('chat', ask());
    expect(response.text).toBe('ok from openrouter');
    expect(binding.ref).toBe('openrouter/backup');
    expect(
      services.log.records.some((r) => r.message === 'Model failed, trying the fallback'),
    ).toBe(true);
  });

  it('does not fall back on a non-provider error (a bug is not a reason to switch models)', async () => {
    const services = testServices();
    const broken = new FlakyProvider('deepseek', [new TypeError('bug')]);
    const backup = new FlakyProvider('openrouter', []);
    const router = new ModelRouter(
      new Map<string, ModelProvider>([
        ['deepseek', broken],
        ['openrouter', backup],
      ]),
      { purposes: { chat: 'deepseek/flash' }, fallbacks: { chat: ['openrouter/backup'] } },
      new ModelCatalog(),
      services.log,
    );
    await expect(router.complete('chat', ask())).rejects.toThrow(TypeError);
    expect(backup.calls).toBe(0);
  });
});

describe('RetryingModelProvider', () => {
  const retrying = (inner: ModelProvider, waits: number[] = []) =>
    new RetryingModelProvider(inner, {
      log: testServices().log,
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep: async (ms) => void waits.push(ms),
    });

  it('retries transient failures with backoff, honouring Retry-After', async () => {
    const inner = new FlakyProvider('deepseek', [transient(), transient(2)]);
    const waits: number[] = [];
    const result = await complete(retrying(inner, waits), { ...ask(), model: 'm' });
    expect(result.text).toBe('ok from deepseek');
    expect(inner.calls).toBe(3);
    expect(waits).toEqual([100, 2000]);
  });

  it('gives up after maxAttempts', async () => {
    const inner = new FlakyProvider('deepseek', [transient(), transient(), transient()]);
    await expect(complete(retrying(inner), { ...ask(), model: 'm' })).rejects.toThrow('HTTP 503');
    expect(inner.calls).toBe(3);
  });

  it('does not retry permanent failures', async () => {
    const inner = new FlakyProvider('deepseek', [permanent()]);
    await expect(complete(retrying(inner), { ...ask(), model: 'm' })).rejects.toThrow('HTTP 401');
    expect(inner.calls).toBe(1);
  });

  it('never retries after a tool call was emitted, so an action is not requested twice', async () => {
    const inner = new FlakyProvider('deepseek', [transient()], true);
    await expect(complete(retrying(inner), { ...ask(), model: 'm' })).rejects.toThrow('HTTP 503');
    expect(inner.calls).toBe(1);
  });
});

describe('MeteredModelProvider', () => {
  it('writes one usage row per request, with cost when the model has a price', async () => {
    const repos = new InMemoryRepositories();
    const services = testServices();
    const catalog = new ModelCatalog([
      { ref: 'deepseek/flash', price: { inputPerMTok: Money.of(1), outputPerMTok: Money.of(2) } },
    ]);
    const metered = new MeteredModelProvider(
      new RedactingModelProvider(
        new ScriptedProvider([{ content: 'a' }, { content: 'b' }], 'deepseek'),
      ),
      { ownerId: owner, usage: repos.usage, catalog, clock: services.clock, log: services.log },
    );

    await complete(metered, {
      ...ask(),
      model: 'flash',
      metadata: { purpose: 'chat', turnId: 't1' },
    });
    await complete(metered, { ...ask(), model: 'unpriced' });

    const rows = await repos.usage.listSince(owner, new Date(0));
    expect(
      rows.map((r) => [r.provider, r.model, r.purpose, r.turnId, r.inputTokens, r.outputTokens]),
    ).toEqual([
      ['deepseek', 'flash', 'chat', 't1', 10, 5],
      ['deepseek', 'unpriced', undefined, undefined, 10, 5],
    ]);
    // 10 in × $1/M + 5 out × $2/M = $0.00002
    expect(rows[0]!.cost!.micros).toBe(20);
    expect(rows[1]!.cost).toBeUndefined();
  });

  it('keeps answering when the usage write fails', async () => {
    const services = testServices();
    const metered = new MeteredModelProvider(
      new ScriptedProvider([{ content: 'still here' }], 'x'),
      {
        ownerId: owner,
        usage: {
          append: async () => {
            throw new Error('db down');
          },
          listSince: async () => [],
        },
        catalog: new ModelCatalog(),
        clock: services.clock,
        log: services.log,
      },
    );
    const result = await complete(metered, { ...ask(), model: 'm' });
    expect(result.text).toBe('still here');
    expect(services.log.records.some((r) => r.message === 'Could not record model usage')).toBe(
      true,
    );
  });
});
