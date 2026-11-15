import type { Agent } from '../application/Agent.js';
import type { PluginManager } from '../application/PluginManager.js';
import type { StartupRecovery } from '../application/StartupRecovery.js';
import type { JobQueue } from '../ports/JobQueue.js';
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
  jobs: JobQueue;
  recovery: StartupRecovery;
  /** Run last on stop(), e.g. closing the database pool. */
  onStop?: readonly (() => Promise<void>)[];
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
  private readonly onStop: readonly (() => Promise<void>)[];
  readonly jobs: JobQueue;
  private readonly recovery: StartupRecovery;
  private started: Channel[] = [];

  constructor(parts: ShitsujiParts) {
    this.agent = parts.agent;
    this.channels = parts.channels;
    this.plugins = parts.plugins;
    this.log = parts.log;
    this.events = parts.events;
    this.version = parts.version;
    this.onStop = parts.onStop ?? [];
    this.jobs = parts.jobs;
    this.recovery = parts.recovery;
  }

  async start(): Promise<void> {
    await this.recovery.run();
    await this.jobs.start();
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
    try {
      await this.jobs.stop();
    } catch (error) {
      this.log.error('Job queue stop failed', { error: serializeError(error) });
    }
    await this.plugins.disposeAll();
    for (const close of this.onStop) {
      try {
        await close();
      } catch (error) {
        this.log.error('Shutdown step failed', { error: serializeError(error) });
      }
    }
    this.log.info('Shitsuji stopped');
  }

  private async handle(channel: Channel, content: string, destination: string): Promise<void> {
    this.log.info('Message received', { channel: channel.name, length: content.length });
    let reply: string;
    try {
      reply = (await this.agent.send(content, { channel: channel.name })).reply;
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
