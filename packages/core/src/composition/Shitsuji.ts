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

/**
 * Everything a running assistant is made of. `createShitsuji()` assembles it; `Shitsuji` owns the
 * lifecycle and never constructs any of these itself. Optional parts are absent in tests and in
 * builds where that feature is off (the API, approvals, the sandbox, the SOUL and the budget).
 */
export interface ShitsujiParts {
  /** The runtime that stores messages, queues turns and runs them (F04). */
  agent: Agent;
  /** The adapters this process may start; `Shitsuji.start` starts each and delivers through them. */
  channels: ChannelRegistry;
  /** Plugin instances whose channels, tools and model providers `createShitsuji` already registered. */
  plugins: PluginManager;
  /** The process logger; every lifecycle step and delivery failure is reported here, never a secret. */
  log: Logger;
  /** The in-process bus every component publishes to and `Shitsuji` subscribes to. */
  events: EventBus;
  /** The build version reported in `/status`, `system.ready` and the console banner. */
  version: string;
  /** The durable queue (`session.drain`, scheduled tasks, …). */
  jobs: JobQueue;
  /** Finishes or fails the turns a previous process left `running`; runs before the queue starts. */
  recovery: StartupRecovery;
  /** Chat → owner/session bindings, read by the inbound gateway. */
  bindings: ChannelBindingStore;
  /** The one-time pairing service used by `/start`. */
  pairing: PairingService;
  /** The repositories the gateway and approval delivery read; services own all writes. */
  repos: Repositories;
  /** The single owner this process serves. */
  ownerId: OwnerId;
  /** The injected clock (tests use a manual one). */
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
 * The running assistant: the facade over the object graph that `createShitsuji()` built. It owns
 * the lifecycle order, not the runtime: it starts recovery, the job queue, the agent (which registers
 * the turn worker), the API and the channels, and turns two event streams into channel output —
 * `turn.status` into replies and typing indicators, `approval.requested` into cards.
 *
 * `createShitsuji()` constructs it and `startServer()` (or a test) calls `start()` once; `stop()` is
 * called once on shutdown. It is not re-entrant: a second `start()` would start the API and every
 * channel again, and a second `stop()` repeats the shutdown hooks. `start()` is asynchronous and
 * awaits each step in order, so a failure (a bad database, a channel that cannot start, a missing
 * owner key) rejects before the next step; already-started pieces are not rolled back.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant S as Shitsuji
 *   participant R as StartupRecovery
 *   participant J as JobQueue
 *   participant A as Agent
 *   participant C as Channels
 *   S->>R: recovery.run()
 *   S->>J: jobs.start()
 *   S->>S: subscribe turn.status
 *   S->>A: agent.start() (registers session.drain)
 *   S->>S: prepare()
 *   S->>S: startApi()
 *   S->>S: build ChannelGateway
 *   S->>C: channel.start() (each, in order)
 *   S->>S: subscribe approval.requested
 *   S->>S: publish system.ready
 * ```
 */
export class Shitsuji {
  /** The runtime channels and the API call; `Shitsuji` only starts and reports it. */
  readonly agent: Agent;
  /** The logger shared with every part; lifecycle steps and delivery failures are logged here. */
  readonly log: Logger;
  /** The bus this facade subscribes to; other components publish through their own references. */
  readonly events: EventBus;
  /** The adapters available to this process; `start` starts them, `deliverTo` looks them up here. */
  private readonly channels: ChannelRegistry;
  /** Disposed last-but-one on stop, after the sandbox and the job queue. */
  private readonly plugins: PluginManager;
  /** Reported in `system.ready` and the console banner. */
  private readonly version: string;
  /** Extra shutdown hooks, run after plugins and sandbox; each failure is logged. */
  private readonly onStop: readonly (() => Promise<void>)[];
  /** The durable queue; public so tests and maintenance tasks can enqueue work. */
  readonly jobs: JobQueue;
  /** Runs before the queue on start, so a recovered turn cannot be started twice. */
  private readonly recovery: StartupRecovery;
  /** Unsubscribes the `turn.status` listener; set in `start`, cleared by `stop`. */
  private offReplies?: () => void;
  /** Unsubscribes the `approval.requested` listener; set after the channels start. */
  private offApprovals?: () => void;
  /** Optional pre-open step (e.g. the owner key); awaited after the agent starts. */
  private readonly prepare?: () => Promise<void>;
  /** Optional API starter; awaited before the channels so adapters can see `apiUrl`. */
  private readonly startApi?: () => Promise<RunningApi>;
  /** The running API, if any; `apiUrl` reads it and `stop` closes it first. */
  private api?: RunningApi;
  /** Only the adapters this process actually started, in start order; `stop` reverses it. */
  private started: ChannelAdapter[] = [];
  /** Chat → owner/session bindings; the inbound gateway uses them. */
  private readonly bindings: ChannelBindingStore;
  /** One-time pairing; the gateway uses it for `/start`. */
  private readonly pairing: PairingService;
  /** The repositories the gateway and approval delivery read. */
  private readonly repos: Repositories;
  /** The one owner this process serves. */
  private readonly ownerId: OwnerId;
  /** The injected clock; this facade never calls `Date.now()` itself. */
  private readonly clock: Clock;
  /** Open cards, exposed through the `approvals` getter for the evaluation harness. */
  private readonly approvalsService?: ApprovalService;
  /** Reads a typed answer for the gateway; only a plain yes or no resolves a card. */
  private readonly readTypedApproval?: (text: string, approval: Approval) => Promise<TypedAnswer>;
  /** The open sandbox; closed on stop after the queue, so no turn writes during the close. */
  private readonly sandbox?: SandboxService;
  /** Built in `start` after the API, because adapters receive its `receive` sink. */
  private gateway?: ChannelGateway;

  /**
   * Stores the parts; does nothing observable. No subscription, no I/O, no validation: optional
   * parts are simply absent, and the caller is responsible for calling `start()` once.
   */
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

  /**
   * Brings the graph to life, in this order: recovery, the job queue, the reply subscription, the
   * agent (which registers `session.drain` and wakes queued turns), the optional prepare step, the
   * optional API, the gateway and every channel, the approval subscription, then `system.ready`.
   *
   * Side effects: it writes through recovery and prepares the owner key; starts the queue, the
   * agent's worker, the API and the adapters; subscribes to two event streams; and publishes
   * `system.ready`. Channels are started **sequentially in registry order**, so a slow adapter
   * delays the next one. The reply listener is installed before any turn can run; a `running`
   * event asks the channel for a typing indicator and a terminal event delivers the reply. Those
   * two deliveries are deliberately not awaited (`void`): the event bus must never block a turn,
   * and a failed delivery is logged rather than retried. Stopping is not automatic on a failure:
   * the rejected promise leaves the earlier pieces running for the caller to `stop()`.
   *
   * Errors: the first failing step (recovery, queue, agent, prepare, API, a channel) rejects; the
   * caller (`startServer`) exits the process.
   */
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

  /**
   * Where the HTTP API listens once `start()` has started it; `undefined` when the API is disabled
   * or has not started yet. The server prints this in its banner.
   */
  get apiUrl(): string | undefined {
    return this.api?.url;
  }

  /** Cards waiting for the owner; the evaluation harness answers them in process (S38). */
  get approvals(): ApprovalService | undefined {
    return this.approvalsService;
  }

  /**
   * Shuts the graph down in reverse order: unsubscribe the reply listener, close the API, stop the
   * channels (newest first), wait up to five seconds for running turns, stop the job queue, close
   * the sandbox, dispose plugins, then run the extra `onStop` hooks. Every channel, queue, sandbox
   * and hook failure is logged and does not stop the rest; plugin disposal is the exception (it is
   * awaited without a catch, so its error would reject `stop()`).
   *
   * The five-second wait is deliberate: a turn still running after it is left to recovery at the
   * next start rather than blocking shutdown. `stop()` is not idempotent by design; the process
   * calls it once from its signal handler.
   */
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

  /**
   * Sends a reply to `"<channel>:<chat>"`. The TUI is not an adapter here: it reads events, so a
   * reply channel that names no started adapter is silently dropped. Called from the `turn.status`
   * listener (fire and forget), never from the runner itself.
   */
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

  /**
   * Delivers an approval card to the chat whose turn is waiting (S37): it reads the turn to find
   * `replyChannel`, finds the adapter that started, and delivers a `question` intent with an
   * `approval` part. It is fire and forget from the `approval.requested` listener; a missing turn,
   * a channel that did not start, an undelivered receipt and any thrown error are logged or
   * ignored, never retried. The card carries the approval id the buttons send back.
   */
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

  /**
   * Lets a channel show a typing or "working" indicator while the turn runs. Called on every
   * `turn.status: running` and deliberately not awaited; an adapter without a `typing` method is
   * skipped, and a failure is logged at `warn`.
   */
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

  /**
   * The one delivery path: finds the started adapter by id, builds text and file parts (text first,
   * then each file with its caption), and awaits `channel.deliver`. An empty body (no text and no
   * files) sends nothing. A receipt that says `delivered: false` is logged at `warn`; a thrown error
   * is logged at `error`; neither is retried, because the turn has already ended and retrying would
   * duplicate a message whose outcome the channel may not report.
   */
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
/**
 * Splits a reply channel on its first colon: `"telegram:12345"` becomes `telegram` and `12345`.
 * A value without a colon is treated as an adapter id with an empty chat id (the TUI pattern); the
 * chat part may itself contain colons, which are kept verbatim.
 */
function splitReplyChannel(replyChannel: string): { channelId: string; chatId: string } {
  const colon = replyChannel.indexOf(':');
  return colon === -1
    ? { channelId: replyChannel, chatId: '' }
    : { channelId: replyChannel.slice(0, colon), chatId: replyChannel.slice(colon + 1) };
}
