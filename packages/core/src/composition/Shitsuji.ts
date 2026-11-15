import type { Agent } from '../application/Agent.js';
import type { PluginManager } from '../application/PluginManager.js';
import { serializeError } from '../domain/errors.js';
import type { Channel } from '../ports/Channel.js';
import type { EventBus } from '../ports/EventBus.js';
import type { Logger } from '../ports/Logger.js';

export interface ShitsujiParts {
  agent: Agent;
  channels: readonly Channel[];
  plugins: PluginManager;
  log: Logger;
  events: EventBus;
  version: string;
}

/**
 * The running assistant: a facade over the object graph built by createShitsuji(). start() connects
 * channels to the agent and starts them; stop() shuts everything down in reverse order.
 */
export class Shitsuji {
  readonly agent: Agent;
  readonly log: Logger;
  readonly events: EventBus;
  private readonly channels: readonly Channel[];
  private readonly plugins: PluginManager;
  private readonly version: string;
  private started: Channel[] = [];

  constructor(parts: ShitsujiParts) {
    this.agent = parts.agent;
    this.channels = parts.channels;
    this.plugins = parts.plugins;
    this.log = parts.log;
    this.events = parts.events;
    this.version = parts.version;
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      channel.onMessage((message, destination) => {
        void this.handle(channel, message.content, destination);
      });
      await channel.start();
      this.started.push(channel);
    }
    this.events.publish('system.ready', { version: this.version });
    this.log.info('Shitsuji started', { channels: this.started.map((c) => c.name) });
  }

  async stop(): Promise<void> {
    for (const channel of [...this.started].reverse()) {
      try {
        await channel.stop();
      } catch (error) {
        this.log.error('Channel stop failed', {
          channel: channel.name,
          error: serializeError(error),
        });
      }
    }
    this.started = [];
    await this.plugins.disposeAll();
    this.log.info('Shitsuji stopped');
  }

  private async handle(channel: Channel, content: string, destination: string): Promise<void> {
    this.log.info('Message received', { channel: channel.name, length: content.length });
    let reply: string;
    try {
      reply = await this.agent.send(content);
    } catch (error) {
      this.log.error('Message failed', { channel: channel.name, error: serializeError(error) });
      reply = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await channel.send(destination, reply);
    } catch (error) {
      this.log.error('Reply failed', { channel: channel.name, error: serializeError(error) });
    }
  }
}
