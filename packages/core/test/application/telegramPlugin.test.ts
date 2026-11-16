import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { TelegramChannelPlugin } from '../../src/plugins/channelPlugins.js';
import type { ChannelAdapter } from '../../src/ports/ChannelAdapter.js';
import type { PluginRegistrationContext } from '../../src/ports/Plugin.js';
import { testServices } from '../helpers.js';

describe('TelegramChannelPlugin (S32)', () => {
  it('registers a pairing-required Telegram channel without touching the network', () => {
    const services = testServices();
    const channels: ChannelAdapter[] = [];
    const ctx = {
      config: {},
      log: new MemoryLogger(),
      events: services.events,
      addChannel: (channel: ChannelAdapter) => channels.push(channel),
      addModelProvider: () => {},
      addTools: () => {},
      addContextInjectable: () => {},
    } satisfies PluginRegistrationContext;

    new TelegramChannelPlugin({
      token: '123456:TEST-token',
      handoffDir: path.join(os.tmpdir(), 'shitsuji-handoff-test'),
    }).register(ctx);

    expect(channels.map((channel) => channel.id)).toEqual(['telegram']);
    expect(channels[0]!.requiresPairing).toBe(true);
  });
});
