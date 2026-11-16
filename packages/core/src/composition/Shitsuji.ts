import type { Agent } from '../application/Agent.js';
import type { PluginManager } from '../application/PluginManager.js';
import type { StartupRecovery } from '../application/StartupRecovery.js';
import type { JobQueue } from '../ports/JobQueue.js';
import type { RunningApi } from './apiServer.js';
import { serializeError } from '../domain/errors.js';
import type { ChannelRegistry } from '../application/channels/ChannelRegistry.js';
import type {
  ChannelAdapter,
  InboundMessage,
  InboundResult,
  OutboundIntent,
} from '../ports/ChannelAdapter.js';
import type { EventBus } from '../ports/EventBus.js';
import type { Logger } from '../ports/Logger.js';

export interface ShitsujiParts {
  agent: Agent;
  channels: ChannelRegistry;
  plugins: PluginManager;
  log: Logger;
  events: EventBus;
  version: string;
  jobs: JobQueue;
  recovery: StartupRecovery;
  /** Runs before the API and the channels open, e.g. creating the owner key they check. */
  prepare?: () => Promise<void>;
  /** Starts the HTTP API, if enabled; called once the agent runs. */
  startApi?: () => Promise<RunningApi>;
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
  private readonly channels: ChannelRegistry;
  private readonly plugins: PluginManager;
  private readonly version: string;
  private readonly onStop: readonly (() => Promise<void>)[];
  readonly jobs: JobQueue;
  private readonly recovery: StartupRecovery;
  private offReplies?: () => void;
  private readonly prepare?: () => Promise<void>;
  private readonly startApi?: () => Promise<RunningApi>;
  private api?: RunningApi;
  private started: ChannelAdapter[] = [];

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
    this.prepare = parts.prepare;
    this.startApi = parts.startApi;
  }

  async start(): Promise<void> {
    await this.recovery.run();
    await this.jobs.start();
    this.offReplies = this.events.subscribe('turn.status', (e) => {
      if (!e.replyChannel || !['succeeded', 'waiting', 'failed', 'cancelled'].includes(e.status))
        return;
      const text =
        e.status === 'succeeded'
          ? (e.reply ?? '')
          : e.status === 'waiting'
            ? (e.question ?? '')
            : `Error: ${e.error ?? e.status}`;
      const intent: OutboundIntent = e.status === 'waiting' ? 'question' : 'final';
      void this.deliver(e.replyChannel, text, intent);
    });
    await this.agent.start();
    await this.prepare?.();
    if (this.startApi) {
      this.api = await this.startApi();
      this.log.info('API listening', { url: this.api.url });
    }
    for (const channel of this.channels.all()) {
      await channel.start({
        receive: (message) => this.receive(channel, message),
      });
      this.started.push(channel);
    }
    this.events.publish('system.ready', { version: this.version });
    this.log.info('Shitsuji started', { channels: this.started.map((c) => c.id) });
  }

  /** Where the API listens, once started. */
  get apiUrl(): string | undefined {
    return this.api?.url;
  }

  async stop(): Promise<void> {
    this.offReplies?.();
    await this.api?.close();
    this.api = undefined;
    for (const channel of [...this.started].reverse()) {
      try {
        await channel.stop();
      } catch (error) {
        this.log.error('Channel stop failed', {
          channel: channel.id,
          error: serializeError(error),
        });
      }
    }
    this.started = [];
    // Give running turns a moment to finish; anything still running is recovered at next start.
    await Promise.race([this.agent.idle(), new Promise((r) => setTimeout(r, 5000))]);
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

  private async receive(channel: ChannelAdapter, message: InboundMessage): Promise<InboundResult> {
    this.log.info('Message received', { channel: channel.id, length: message.text.length });
    // The reply comes back through turn.status (see start()), addressed by replyChannel.
    return this.agent.submit(message.text, {
      ...(message.sessionId && { sessionId: message.sessionId }),
      channel: channel.id,
      replyChannel: `${channel.id}:${message.chatId}`,
    });
  }

  /** Sends a reply to "<channel>:<chat>"; a channel that is not running here (the TUI) reads events. */
  private async deliver(replyChannel: string, text: string, intent: OutboundIntent): Promise<void> {
    const colon = replyChannel.indexOf(':');
    const id = colon === -1 ? replyChannel : replyChannel.slice(0, colon);
    const chatId = colon === -1 ? '' : replyChannel.slice(colon + 1);
    const channel = this.started.find((c) => c.id === id);
    if (!channel) return;
    try {
      const receipt = await channel.deliver(
        { chatId },
        { parts: [{ kind: 'text', markdown: text }], intent },
      );
      if (!receipt.delivered) {
        this.log.warn('Reply not delivered', { channel: id, reason: receipt.reason });
      }
    } catch (error) {
      this.log.error('Reply failed', { channel: id, error: serializeError(error) });
    }
  }
}
