import type { OwnerId, SessionId } from '../../domain/model/ids.js';
import type { SessionKind } from '../../domain/model/Session.js';
import type { ChannelBinding, ChannelBindingStore } from '../../ports/ChannelBindingStore.js';
import type {
  InboundAttachment,
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
  submit(
    content: string,
    opts: { sessionId?: SessionId; channel?: string; replyChannel?: string },
  ): Promise<Submitted>;
  startSession(kind?: SessionKind): Promise<SessionId>;
  stopSession(sessionId: SessionId): Promise<boolean>;
}

export interface ChannelGatewayDeps {
  agent: ChannelRuntime;
  bindings: ChannelBindingStore;
  pairing: PairingService;
  channels: ChannelRegistry;
  repos: Repositories;
  ownerId: OwnerId;
  clock: Clock;
  log: Logger;
  version: string;
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
  constructor(private readonly deps: ChannelGatewayDeps) {}

  async receive(message: InboundMessage): Promise<InboundResult> {
    const text = withAttachments(message.text.trim(), message.attachments);
    if (!text) return { kind: 'ignored', reason: 'empty message' };
    const binding = await this.deps.bindings.get(message.channel, message.chatId);
    const adapter = this.deps.channels.get(message.channel);

    if (adapter?.requiresPairing && !binding?.verifiedAt) {
      if (/^\/start(\s|$)/i.test(text)) return this.pair(message, text);
      this.deps.log.warn('Ignoring a message from an unpaired chat', {
        channel: message.channel,
      });
      return { kind: 'ignored', reason: 'unpaired' };
    }

    const command = commandOf(text);
    if (command) return this.command(message, command, binding);

    const submitted = await this.deps.agent.submit(text, {
      ...(binding?.sessionId && { sessionId: binding.sessionId }),
      channel: message.channel,
      replyChannel: `${message.channel}:${message.chatId}`,
    });
    return { kind: 'turn', ...submitted };
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

  private answer(message: InboundMessage, text: string, intent: OutboundIntent): Promise<void> {
    return this.deps.reply(message.channel, message.chatId, text, intent);
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

type Command = 'stop' | 'status' | 'new' | 'new-confirm';

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
    default:
      return undefined;
  }
}

/** Tells the turn where the owner's files are, so it can read them if the task needs them. */
function withAttachments(text: string, attachments?: readonly InboundAttachment[]): string {
  if (!attachments?.length) return text;
  const lines = attachments.map(
    (file) => `- ${file.path}${file.mediaType ? ` (${file.mediaType})` : ''}`,
  );
  return [text, 'The owner sent these files; they are saved for you:', ...lines]
    .filter(Boolean)
    .join('\n');
}
