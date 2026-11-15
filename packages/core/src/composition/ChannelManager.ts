import { type Channel } from '../ports/Channel.js';
import { CLIChannel } from '../adapters/channels/CLIChannel.js';
import { WebhookChannel, type WebhookChannelOptions } from '../adapters/channels/WebhookChannel.js';
import type { Logger } from '../ports/Logger.js';

export type ChannelType = 'cli' | 'webhook';

export class ChannelManager {
  constructor(private readonly log: Logger) {}

  private channels = new Map<string, Channel>();

  async createChannel(type: ChannelType, options?: WebhookChannelOptions): Promise<Channel> {
    let channel: Channel;

    switch (type) {
      case 'cli':
        channel = new CLIChannel(this.log);
        break;
      case 'webhook':
        channel = new WebhookChannel(this.log, options);
        break;
      default:
        throw new Error(`Unknown channel type: ${type}`);
    }

    this.channels.set(channel.name, channel);
    this.log.info(`Created channel: ${channel.name}`);
    return channel;
  }

  async startChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) {
      throw new Error(`Channel not found: ${name}`);
    }
    await channel.start();
  }

  async stopChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) {
      throw new Error(`Channel not found: ${name}`);
    }
    await channel.stop();
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  list(): Channel[] {
    return Array.from(this.channels.values());
  }

  listNames(): string[] {
    return Array.from(this.channels.keys());
  }
}

export { type Channel, BaseChannel } from '../ports/Channel.js';
export { CLIChannel } from '../adapters/channels/CLIChannel.js';
export { WebhookChannel } from '../adapters/channels/WebhookChannel.js';
