import type { Agent } from '../application/Agent.js';
import type { PluginManager } from '../application/PluginManager.js';
import type { StartupRecovery } from '../application/StartupRecovery.js';
import type { JobQueue } from '../ports/JobQueue.js';
import type { RunningApi } from './apiServer.js';
import { serializeError } from '../domain/errors.js';
import type { ChannelRegistry } from '../application/channels/ChannelRegistry.js';
import { ChannelGateway } from '../application/channels/ChannelGateway.js';
import type { PairingService } from '../application/channels/PairingService.js';
import type { ChannelAdapter, OutboundIntent, OutboundPart } from '../ports/ChannelAdapter.js';
import type { OutboundFile } from '../ports/Tool.js';
import type { ChannelBindingStore } from '../ports/ChannelBindingStore.js';
import type { Clock } from '../ports/Clock.js';
import type { EventBus } from '../ports/EventBus.js';
import type { Logger } from '../ports/Logger.js';
import type { ApprovalService } from '../application/trust/ApprovalService.js';
import type { TypedAnswer } from '../application/trust/TypedApprovalReader.js';
import type { Approval } from '../domain/model/Approval.js';
import { asId, type OwnerId, type TurnId } from '../domain/model/ids.js';
import type { Repositories } from '../ports/Repositories.js';
import type { SandboxService } from '../application/sandbox/SandboxService.js';

export interface ShitsujiParts {
  agent: Agent;
  channels: ChannelRegistry;
  plugins: PluginManager;
  log: Logger;
  events: EventBus;
  version: string;
  jobs: JobQueue;
  recovery: StartupRecovery;
  bindings: ChannelBindingStore;
  pairing: PairingService;
  repos: Repositories;
  ownerId: OwnerId;
  clock: Clock;
  /** The sandbox core's tools run in (F08, S40); closed on stop. */
  sandbox?: SandboxService;
  /** Cards waiting for the owner; Telegram sends them with buttons (S37). */
  approvals?: ApprovalService;
  /** Reads a typed answer to an open card; only an unconditional yes approves (S37). */
  readTypedApproval?: (text: string, approval: Approval) => Promise<TypedAnswer>;
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
  private offApprovals?: () => void;
  private readonly prepare?: () => Promise<void>;
  private readonly startApi?: () => Promise<RunningApi>;
  private api?: RunningApi;
  private started: ChannelAdapter[] = [];
  private readonly bindings: ChannelBindingStore;
  private readonly pairing: PairingService;
  private readonly repos: Repositories;
  private readonly ownerId: OwnerId;
  private readonly clock: Clock;
  private readonly approvalsService?: ApprovalService;
  private readonly readTypedApproval?: (text: string, approval: Approval) => Promise<TypedAnswer>;
  private readonly sandbox?: SandboxService;
  private gateway?: ChannelGateway;

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
    this.bindings = parts.bindings;
    this.pairing = parts.pairing;
    this.repos = parts.repos;
    this.ownerId = parts.ownerId;
    this.clock = parts.clock;
    this.approvalsService = parts.approvals;
    this.readTypedApproval = parts.readTypedApproval;
    this.sandbox = parts.sandbox;
  }

  async start(): Promise<void> {
    await this.recovery.run();
    await this.jobs.start();
    this.offReplies = this.events.subscribe('turn.status', (e) => {
      if (!e.replyChannel) return;
      if (e.status === 'running') {
        void this.showTyping(e.replyChannel);
        return;
      }
      if (!['succeeded', 'waiting', 'failed', 'cancelled'].includes(e.status)) return;
      // A cancelled turn is one the owner stopped; /stop already answered "Stopped.", so an
      // "Error: stopped by owner" on top of it is noise, not news (#68).
      if (e.status === 'cancelled') return;
      const text =
        e.status === 'succeeded'
          ? (e.reply ?? '')
          : e.status === 'waiting'
            ? (e.question ?? '')
            : `Error: ${e.error ?? e.status}`;
      const intent: OutboundIntent = e.status === 'waiting' ? 'question' : 'final';
      void this.deliver(e.replyChannel, text, intent, e.files, asId<TurnId>(e.turnId));
    });
    await this.agent.start();
    await this.prepare?.();
    if (this.startApi) {
      this.api = await this.startApi();
      this.log.info('API listening', { url: this.api.url });
    }
    this.gateway = new ChannelGateway({
      agent: this.agent,
      bindings: this.bindings,
      pairing: this.pairing,
      channels: this.channels,
      repos: this.repos,
      ownerId: this.ownerId,
      clock: this.clock,
      log: this.log,
      version: this.version,
      ...(this.approvalsService && { approvals: this.approvalsService }),
      ...(this.readTypedApproval && { readTypedApproval: this.readTypedApproval }),
      reply: (channelId, chatId, text, intent) => this.deliverTo(channelId, chatId, text, intent),
    });
    for (const channel of this.channels.all()) {
      await channel.start({
        receive: (message) => this.gateway!.receive(message),
        accepts: (chat) => this.gateway!.accepts(chat),
      });
      this.started.push(channel);
    }
    // Cards need the channels, so subscribe once they are running.
    this.offApprovals = this.events.subscribe('approval.requested', (e) => {
      void this.deliverApproval(e);
    });
    this.events.publish('system.ready', { version: this.version });
    this.log.info('Shitsuji started', { channels: this.started.map((c) => c.id) });
  }

  /** Where the API listens, once started. */
  get apiUrl(): string | undefined {
    return this.api?.url;
  }

  /** Cards waiting for the owner; the evaluation harness answers them in process (S38). */
  get approvals(): ApprovalService | undefined {
    return this.approvalsService;
  }

  async stop(): Promise<void> {
    this.offReplies?.();
    this.offApprovals?.();
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
    try {
      await this.sandbox?.close();
    } catch (error) {
      this.log.error('Sandbox close failed', { error: serializeError(error) });
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

  /** Sends a reply to "<channel>:<chat>"; a channel that is not running here (the TUI) reads events. */
  private async deliver(
    replyChannel: string,
    text: string,
    intent: OutboundIntent,
    files: readonly OutboundFile[] = [],
    turnId?: TurnId,
  ): Promise<void> {
    const { channelId, chatId } = splitReplyChannel(replyChannel);
    await this.deliverTo(channelId, chatId, text, intent, files, turnId);
  }

  /** Sends an approval card to the chat whose turn is waiting (S37). */
  private async deliverApproval(event: {
    approvalId: string;
    turnId: string;
    summary: string;
  }): Promise<void> {
    try {
      const turn = await this.repos.turns.get(asId<TurnId>(event.turnId));
      const replyChannel = turn?.toProps().replyChannel;
      if (!replyChannel) return;
      const { channelId, chatId } = splitReplyChannel(replyChannel);
      const channel = this.started.find((c) => c.id === channelId);
      if (!channel) return;
      const receipt = await channel.deliver(
        { chatId },
        {
          parts: [
            {
              kind: 'approval',
              approvalId: event.approvalId,
              summary: event.summary,
              actionLabel: 'Approve',
            },
          ],
          intent: 'question',
        },
      );
      if (!receipt.delivered) {
        this.log.warn('Approval card not delivered', {
          channel: channelId,
          reason: receipt.reason,
        });
      }
    } catch (error) {
      this.log.error('Approval card delivery failed', { error: serializeError(error) });
    }
  }

  /** Lets a channel show a typing or "working" indicator while the turn runs. */
  private async showTyping(replyChannel: string): Promise<void> {
    const { channelId, chatId } = splitReplyChannel(replyChannel);
    const channel = this.started.find((c) => c.id === channelId);
    if (!channel?.typing) return;
    try {
      await channel.typing({ chatId });
    } catch (error) {
      this.log.warn('Typing indicator failed', {
        channel: channelId,
        error: serializeError(error),
      });
    }
  }

  private async deliverTo(
    channelId: string,
    chatId: string,
    text: string,
    intent: OutboundIntent,
    files: readonly OutboundFile[] = [],
    turnId?: TurnId,
  ): Promise<void> {
    const channel = this.started.find((c) => c.id === channelId);
    if (!channel) return;
    const parts: OutboundPart[] = [];
    if (text) parts.push({ kind: 'text', markdown: text });
    for (const file of files) {
      parts.push({
        kind: 'file',
        fileRef: {
          name: file.name,
          path: file.path,
          ...(file.mediaType && { mediaType: file.mediaType }),
        },
        ...(file.caption && { caption: file.caption }),
      });
    }
    if (!parts.length) return;
    try {
      const receipt = await channel.deliver(
        { chatId, ...(turnId && { turnId }) },
        { parts, intent },
      );
      if (!receipt.delivered) {
        this.log.warn('Reply not delivered', { channel: channelId, reason: receipt.reason });
      }
    } catch (error) {
      this.log.error('Reply failed', { channel: channelId, error: serializeError(error) });
    }
  }
}

/** "telegram:12345" → { channelId: "telegram", chatId: "12345" }. */
function splitReplyChannel(replyChannel: string): { channelId: string; chatId: string } {
  const colon = replyChannel.indexOf(':');
  return colon === -1
    ? { channelId: replyChannel, chatId: '' }
    : { channelId: replyChannel.slice(0, colon), chatId: replyChannel.slice(colon + 1) };
}
