import { describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import type { Agent } from '../../src/application/Agent.js';
import type { ChannelRegistry } from '../../src/application/channels/ChannelRegistry.js';
import type { PluginManager } from '../../src/application/PluginManager.js';
import { Shitsuji, type ShitsujiParts } from '../../src/composition/Shitsuji.js';
import type { Clock } from '../../src/ports/Clock.js';
import type { EventBus } from '../../src/ports/EventBus.js';
import type { JobQueue } from '../../src/ports/JobQueue.js';
import type { ChannelBindingStore } from '../../src/ports/ChannelBindingStore.js';
import type { PairingService } from '../../src/application/channels/PairingService.js';
import type { Repositories } from '../../src/ports/Repositories.js';
import type { StartupRecovery } from '../../src/application/StartupRecovery.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';

/** Just enough of the graph for `stop()`: it only touches these parts. */
const parts = (overrides: Partial<ShitsujiParts>): ShitsujiParts => ({
  agent: { idle: async () => undefined } as unknown as Agent,
  channels: { all: () => [] } as unknown as ChannelRegistry,
  plugins: { disposeAll: async () => undefined } as unknown as PluginManager,
  log: new MemoryLogger(),
  events: {} as EventBus,
  version: 'test',
  jobs: { stop: async () => undefined } as unknown as JobQueue,
  recovery: {} as StartupRecovery,
  bindings: {} as ChannelBindingStore,
  pairing: {} as PairingService,
  repos: {} as Repositories,
  ownerId: asId<OwnerId>('owner'),
  clock: {} as Clock,
  ...overrides,
});

describe('Shitsuji.stop (#95)', () => {
  it('still runs the shutdown hooks and logs when plugin disposal throws', async () => {
    const log = new MemoryLogger();
    const hook = vi.fn(async () => undefined);
    const shitsuji = new Shitsuji(
      parts({
        log,
        plugins: {
          disposeAll: async () => {
            throw new Error('plugin dispose failed');
          },
        } as unknown as PluginManager,
        onStop: [hook],
      }),
    );

    await expect(shitsuji.stop()).resolves.toBeUndefined();

    expect(hook).toHaveBeenCalledTimes(1);
    const messages = log.records.map((record) => record.message);
    expect(messages).toContain('Plugin dispose failed');
    expect(messages).toContain('Shitsuji stopped');
  });

  it('unrefs and clears the five-second wait timer (#98)', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(timer as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    try {
      const shitsuji = new Shitsuji(parts({}));
      await shitsuji.stop();

      expect(unref).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
