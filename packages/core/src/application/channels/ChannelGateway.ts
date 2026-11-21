import type { OwnerId, SessionId } from '../../domain/model/ids.js';
import { asId, type ApprovalId } from '../../domain/model/ids.js';
import { NotFound } from '../../domain/errors.js';
import type { SessionKind } from '../../domain/model/Session.js';
import type { ApprovalService } from '../trust/ApprovalService.js';
import type { TypedAnswer } from '../trust/TypedApprovalReader.js';
import type { Approval } from '../../domain/model/Approval.js';
import type { ChannelBinding, ChannelBindingStore } from '../../ports/ChannelBindingStore.js';
import type {
  InboundAttachment,
  InboundChat,
  InboundMessage,
  InboundResult,
  OutboundIntent,
} from '../../ports/ChannelAdapter.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories } from '../../ports/Repositories.js';
import type { Submitted } from '../runtime/MessageIntake.js';
import type { ChannelRegistry } from './ChannelRegistry.js';
import type { PairingService } from './PairingService.js';

/** What the gateway needs from the runtime; Agent satisfies it. */
export interface ChannelRuntime {
  /** Stores an owner message and returns the turn that answers it. */
  submit(
    content: string,
    opts: { sessionId?: SessionId; channel?: string; replyChannel?: string },
  ): Promise<Submitted>;
  /** Starts a fresh session in the owner's thread, for `/new`. */
  startSession(kind?: SessionKind): Promise<SessionId>;
  /** Stops the session's running or queued turn, for `/stop`. */
  stopSession(sessionId: SessionId): Promise<boolean>;
}

/** Everything the gateway is built with; `Shitsuji.start` assembles it after the API is up. */
export interface ChannelGatewayDeps {
  /** The runtime that stores messages and starts turns. */
  agent: ChannelRuntime;
  /** Chat → owner/session bindings; pairing writes them, the gateway reads them. */
  bindings: ChannelBindingStore;
  /** One-time pairing codes for `/start`. */
  pairing: PairingService;
  /** The adapters this process started; the gateway delivers answers and cards through them. */
  channels: ChannelRegistry;
  /** Turn and thread storage, for `/status` and the session lookup. */
  repos: Repositories;
  /** The single owner this process serves. */
  ownerId: OwnerId;
  /** Injected clock for binding timestamps and the unpaired-chat throttle. */
  clock: Clock;
  /** Structured logger for pairing, delivery and ignored messages. */
  log: Logger;
  /** The build version `/status` reports. */
  version: string;
  /** Cards waiting for the owner, answered by a button (S37). */
  approvals?: ApprovalService;
  /** Reads a typed reply to an open card; only an unconditional yes approves (S37). */
  readTypedApproval?: (text: string, approval: Approval) => Promise<TypedAnswer>;
  /** Maps a host handoff path to the active driver's path for the attachment note (#100). */
  attachmentPath?: (hostPath: string) => Promise<string>;
  /** The viewer's URL when the active sandbox has a desktop (S51); absent otherwise. */
  viewerUrl?: string;
  /** Which allowed apps publish an accessibility tree, for `/status` (S54); absent without one. */
  accessibility?: () => Promise<
    | {
        /** True when the helper process answers. */
        helper: boolean;
        /** Allowed apps that published no tree. */
        missing: readonly string[];
      }
    | undefined
  >;
  /** Answers directly through the channel adapter that received the message. */
  reply: (channel: string, chatId: string, text: string, intent: OutboundIntent) => Promise<void>;
}

/**
 * The one door for inbound channel messages (F06, S31). It resolves a chat to the owner's thread
 * through a binding, pairs a new chat once, answers commands itself, and hands everything else to the
 * agent as a turn whose reply goes back on the channel it came from. A channel with
 * `requiresPairing` starts no turn until its chat is paired.
 */
export class ChannelGateway {
  /** The unpaired-chat log throttle: channel:chat -> last warning and how many it covered (#39). */
  private readonly unpairedWarnings = new Map<
    string,
    {
      /** When the last warning was written, in epoch milliseconds. */
      at: number;
      /** How many messages were dropped since then without a line. */
      suppressed: number;
    }
  >();

  constructor(
    /** The runtime, channels and stores; `Shitsuji.start` builds it once. */
    private readonly deps: ChannelGatewayDeps,
  ) {}

  /**
   * Whether a chat may start a turn. Adapters ask before storing an attachment, so an unpaired chat
   * cannot download files or get a voice-note reply (F06, #44).
   */
  async accepts(chat: InboundChat): Promise<boolean> {
    const adapter = this.deps.channels.get(chat.channel);
    if (!adapter?.requiresPairing) return true;
    const binding = await this.deps.bindings.get(chat.channel, chat.chatId);
    return Boolean(binding?.verifiedAt);
  }

  /** Handles one inbound message: pairing, commands, a typed approval answer, or a turn. */
  async receive(message: InboundMessage): Promise<InboundResult> {
    const binding = await this.deps.bindings.get(message.channel, message.chatId);
    const adapter = this.deps.channels.get(message.channel);
    const paired = !adapter?.requiresPairing || Boolean(binding?.verifiedAt);

    if (message.callback) {
      if (!paired) {
        this.deps.log.warn('Ignoring a button press from an unpaired chat', {
          channel: message.channel,
        });
        return { kind: 'ignored', reason: 'unpaired' };
      }
      return this.callback(message);
    }

    const text = await withAttachments(
      message.text.trim(),
      message.attachments,
      this.deps.attachmentPath,
    );
    if (!text) return { kind: 'ignored', reason: 'empty message' };

    if (!paired) {
      if (/^\/start(\s|$)/i.test(text)) return this.pair(message, text);
      this.warnUnpaired(message);
      return { kind: 'ignored', reason: 'unpaired' };
    }

    // A paired chat does not need /start; the code must not reach the model (#39).
    if (/^\/start(\s|$)/i.test(text)) {
      await this.answer(message, 'Already paired. Nothing else is needed.', 'final');
      return { kind: 'replied', reason: 'command' };
    }

    const command = commandOf(text);
    if (command) return this.command(message, command, binding);

    // A typed answer to an open card is read on its own; anything but an unconditional yes or no
    // falls through as an ordinary message (S37).
    const typed = await this.typedAnswer(message, text, binding);
    if (typed) return typed;

    const submitted = await this.deps.agent.submit(text, {
      ...(binding?.sessionId && { sessionId: binding.sessionId }),
      channel: message.channel,
      replyChannel: `${message.channel}:${message.chatId}`,
    });
    return { kind: 'turn', ...submitted };
  }

  /** A typed yes or no for the chat's open card; anything else is not an approval (S37). */
  private async typedAnswer(
    message: InboundMessage,
    text: string,
    binding: ChannelBinding | undefined,
  ): Promise<InboundResult | undefined> {
    if (!this.deps.approvals || !this.deps.readTypedApproval) return undefined;
    const { card, count } = await this.pendingFor(binding);
    if (!card) {
      // Never guess which card a typed answer means (#51). Buttons carry the approval id.
      if (count > 1) {
        await this.answer(
          message,
          'More than one approval is waiting. Use the buttons on the card you mean.',
          'final',
        );
        return { kind: 'replied', reason: 'approval-ambiguous' };
      }
      return undefined;
    }
    const answer = await this.deps.readTypedApproval(text, card);
    if (answer === 'unclear') return undefined;
    await this.deps.approvals.resolve(card.id, answer);
    await this.answer(message, answer === 'approve' ? 'Approved.' : 'Declined.', 'final');
    return { kind: 'replied', reason: answer === 'approve' ? 'approved' : 'declined' };
  }

  /**
   * The open cards for this chat's session. A typed answer is accepted only when exactly one is
   * waiting here; cards from another session are never in reach (#51).
   */
  private async pendingFor(binding: ChannelBinding | undefined): Promise<{
    /** The single open card, when exactly one is waiting. */
    card?: Approval;
    /** How many cards are open for the session; more than one refuses a typed answer. */
    count: number;
  }> {
    if (!this.deps.approvals) return { count: 0 };
    const sessionId = await this.sessionFor(binding);
    if (!sessionId) return { count: 0 };
    const open = (await this.deps.approvals.listOpen()).filter((a) => a.sessionId === sessionId);
    return { count: open.length, ...(open.length === 1 && { card: open[0] }) };
  }

  /** A button press on an approval card: `y:<id>` or `n:<id>` (S37). */
  private async callback(message: InboundMessage): Promise<InboundResult> {
    const match = /^([yn]):([A-Za-z0-9_-]{1,64})$/.exec(message.callback?.data ?? '');
    if (!match || !this.deps.approvals) {
      return { kind: 'ignored', reason: 'unknown callback' };
    }
    try {
      const approval = await this.deps.approvals.resolve(
        asId<ApprovalId>(match[2]!),
        match[1] === 'y' ? 'approve' : 'decline',
      );
      if (approval.status === 'approved') return { kind: 'replied', reason: 'approved' };
      if (approval.status === 'declined') return { kind: 'replied', reason: 'declined' };
      return { kind: 'ignored', reason: 'approval not open' };
    } catch (error) {
      if (error instanceof NotFound) return { kind: 'ignored', reason: 'approval not found' };
      throw error;
    }
  }

  /** `/stop`, `/status`, `/new` and `/new confirm` answered here, without a model call. */
  private async command(
    message: InboundMessage,
    command: Command,
    binding: ChannelBinding | undefined,
  ): Promise<InboundResult> {
    switch (command) {
      case 'stop': {
        const sessionId = await this.sessionFor(binding);
        const stopped = sessionId ? await this.deps.agent.stopSession(sessionId) : false;
        await this.answer(message, stopped ? 'Stopped.' : 'Nothing is running.', 'final');
        return { kind: 'replied', reason: 'command' };
      }
      case 'status': {
        const sessionId = await this.sessionFor(binding);
        const turns = sessionId ? await this.deps.repos.turns.listBySession(sessionId) : [];
        const running = turns.some((turn) => turn.status === 'running');
        const queued = turns.filter((turn) => turn.status === 'queued').length;
        const parts = [
          `Shitsuji ${this.deps.version} is ${running ? 'working on a turn' : 'idle'}.`,
        ];
        if (queued) parts.push(`${queued} turn${queued === 1 ? '' : 's'} queued.`);
        if (sessionId) parts.push(`Session ${sessionId.slice(0, 8)}.`);
        const a11y = await this.deps.accessibility?.().catch(() => undefined);
        if (a11y && !a11y.helper) {
          parts.push('The desktop accessibility helper is not running.');
        } else if (a11y?.missing.length) {
          parts.push(`No accessibility tree from: ${a11y.missing.join(', ')}.`);
        }
        await this.answer(message, parts.join(' '), 'final');
        return { kind: 'replied', reason: 'command' };
      }
      case 'new':
        await this.answer(message, 'Reply /new confirm to start a new conversation.', 'question');
        return { kind: 'replied', reason: 'command' };
      case 'new-confirm': {
        const sessionId = await this.deps.agent.startSession('chat');
        const current = await this.deps.bindings.get(message.channel, message.chatId);
        await this.deps.bindings.upsert({
          channel: message.channel,
          externalChatId: message.chatId,
          ownerId: current?.ownerId ?? this.deps.ownerId,
          ...(current?.verifiedAt && { verifiedAt: current.verifiedAt }),
          sessionId,
        });
        await this.answer(message, 'A new conversation has started.', 'final');
        return { kind: 'replied', reason: 'command' };
      }
      case 'desktop':
        await this.answer(
          message,
          this.deps.viewerUrl
            ? `Watch the desktop (watch-only): ${this.deps.viewerUrl}`
            : 'The desktop viewer is not available for this sandbox.',
          'final',
        );
        return { kind: 'replied', reason: 'command' };
    }
  }

  /** `/start <code>` from an unpaired chat: consume the code, bind the chat, and answer. */
  private async pair(message: InboundMessage, text: string): Promise<InboundResult> {
    const code = text.replace(/^\/start\s*/i, '').trim();
    if (!code) {
      await this.answer(
        message,
        'Send /start <code> with the code shown by /pair in the TUI.',
        'question',
      );
      return { kind: 'replied', reason: 'paired' };
    }
    const owner = this.deps.pairing.consume(code, this.deps.clock.now());
    if (!owner) {
      await this.answer(
        message,
        'That pairing code is not valid or has expired. Ask for a new one with /pair.',
        'final',
      );
      return { kind: 'replied', reason: 'paired' };
    }
    await this.deps.bindings.upsert({
      channel: message.channel,
      externalChatId: message.chatId,
      ownerId: owner,
      verifiedAt: this.deps.clock.now(),
    });
    this.deps.log.info('Chat paired', { channel: message.channel });
    await this.answer(message, 'Paired. Say something when you are ready.', 'final');
    return { kind: 'replied', reason: 'paired' };
  }

  /** Delivers a short answer through the adapter that received the message. */
  private answer(message: InboundMessage, text: string, intent: OutboundIntent): Promise<void> {
    return this.deps.reply(message.channel, message.chatId, text, intent);
  }

  /**
   * One warning per chat per minute, with a count in between: anyone who finds the bot can send
   * messages, and the log must not grow with them (#39). The map is bounded for the same reason.
   */
  private warnUnpaired(message: InboundMessage): void {
    const key = `${message.channel}:${message.chatId}`;
    const now = this.deps.clock.now().getTime();
    const entry = this.unpairedWarnings.get(key);
    if (entry && now - entry.at < 60_000) {
      entry.suppressed++;
      return;
    }
    this.deps.log.warn(
      entry
        ? 'Ignoring more messages from an unpaired chat'
        : 'Ignoring a message from an unpaired chat',
      { channel: message.channel, ...(entry && { suppressed: entry.suppressed }) },
    );
    this.unpairedWarnings.set(key, { at: now, suppressed: 0 });
    if (this.unpairedWarnings.size > 500) {
      const oldest = this.unpairedWarnings.keys().next().value;
      if (oldest !== undefined) this.unpairedWarnings.delete(oldest);
    }
  }

  /** The session a chat talks to: its own after /new, else the owner's main chat. */
  protected async sessionFor(binding: ChannelBinding | undefined): Promise<SessionId | undefined> {
    if (binding?.sessionId) return binding.sessionId;
    const thread = await this.deps.repos.threads.getOrCreateForOwner(
      this.deps.ownerId,
      this.deps.clock.now(),
    );
    return (await this.deps.repos.sessions.findMainChat(thread.id))?.id;
  }
}

type Command = 'stop' | 'status' | 'new' | 'new-confirm' | 'desktop';

/** Commands are exact and case-insensitive; anything else is a message. */
function commandOf(text: string): Command | undefined {
  switch (text.toLowerCase()) {
    case '/stop':
      return 'stop';
    case '/status':
      return 'status';
    case '/new':
      return 'new';
    case '/new confirm':
      return 'new-confirm';
    case '/desktop':
      return 'desktop';
    default:
      return undefined;
  }
}

/**
 * Tells the turn where the owner's files are, in the active driver's terms (#100): the mapper turns
 * core's `<dataDir>/handoff` path into the sandbox's display path. Without one (a test or a bare
 * gateway), the host path is kept.
 */
async function withAttachments(
  text: string,
  attachments?: readonly InboundAttachment[],
  display: (hostPath: string) => Promise<string> = async (hostPath) => hostPath,
): Promise<string> {
  if (!attachments?.length) return text;
  const lines = await Promise.all(
    attachments.map(async (file) => {
      const shown = await display(file.path);
      return `- ${shown}${file.mediaType ? ` (${file.mediaType})` : ''}`;
    }),
  );
  return [text, 'The owner sent these files; they are saved for you:', ...lines]
    .filter(Boolean)
    .join('\n');
}
