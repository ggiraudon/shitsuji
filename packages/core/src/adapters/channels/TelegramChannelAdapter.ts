import type { Logger } from '../../ports/Logger.js';
import type {
  ChannelCapabilities,
  ChannelTarget,
  DeliveryReceipt,
  InboundAttachment,
  InboundSink,
  OutboundMessage,
} from '../../ports/ChannelAdapter.js';
import { BaseChannelAdapter } from '../../ports/ChannelAdapter.js';
import type { HandoffStore } from '../files/HandoffStore.js';
import type { TelegramIncoming, TelegramTransport } from './TelegramTransport.js';
import { TelegramRenderer } from './TelegramRenderer.js';

export interface TelegramAdapterOptions {
  /** Where attachments are stored; without it, files are skipped with a warning. */
  handoff?: HandoffStore;
  renderer?: TelegramRenderer;
}

/**
 * Telegram as a chat channel (F06, S32): long polling through the transport, Markdown rendered to
 * Telegram HTML, long replies split, and one "Working…" message removed when the reply arrives. It
 * requires pairing, so the gateway starts no turn until the owner sends /start <code>.
 */
export class TelegramChannelAdapter extends BaseChannelAdapter {
  readonly id = 'telegram';
  override readonly requiresPairing = true;
  readonly capabilities: ChannelCapabilities = {
    markdown: 'full',
    buttons: false,
    files: false,
    images: false,
    voice: false,
    edits: true,
    maxMessageLength: 4096,
  };

  /** The "Working…" message per chat, removed when the turn's reply is delivered. */
  private readonly working = new Map<string, number>();
  private readonly handoff?: HandoffStore;
  private readonly renderer: TelegramRenderer;

  constructor(
    private readonly transport: TelegramTransport,
    private readonly log: Logger,
    options: TelegramAdapterOptions = {},
  ) {
    super();
    this.handoff = options.handoff;
    this.renderer = options.renderer ?? new TelegramRenderer();
  }

  override async start(sink: InboundSink): Promise<void> {
    await super.start(sink);
    await this.transport.start((message) => void this.onMessage(message));
  }

  override async stop(): Promise<void> {
    await this.transport.stop();
    this.working.clear();
    await super.stop();
  }

  async deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    await this.clearWorking(target.chatId);
    const { chunks, degraded } = this.renderer.render(message);
    if (degraded.length) {
      this.log.debug('Telegram degraded message parts to text', { parts: degraded });
    }
    if (!chunks.length) return { delivered: true };
    let first: number | undefined;
    for (const html of chunks) {
      const messageId = await this.transport.sendMessage(target.chatId, html);
      first ??= messageId;
    }
    return first === undefined
      ? { delivered: true }
      : { delivered: true, externalId: String(first) };
  }

  /** Shows that the turn is working: one message, replaced by the reply when it arrives. */
  async typing(target: ChannelTarget): Promise<void> {
    if (this.working.has(target.chatId)) return;
    try {
      await this.transport.sendTyping(target.chatId);
      const messageId = await this.transport.sendMessage(target.chatId, 'Working…');
      this.working.set(target.chatId, messageId);
    } catch (error) {
      this.log.warn('Could not show Telegram typing', {
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
    }
  }

  private async onMessage(message: TelegramIncoming): Promise<void> {
    if (!this.sink) return;
    try {
      if (message.attachment?.kind === 'voice') {
        // Keep the file for F23, but do not start a turn the agent cannot hear.
        await this.storeAttachment(message);
        await this.transport.sendMessage(message.chatId, "I can't listen to voice notes yet.");
        return;
      }
      const attachment = message.attachment ? await this.storeAttachment(message) : undefined;
      await this.sink.receive({
        channel: this.id,
        chatId: message.chatId,
        text: message.text,
        externalId: String(message.messageId),
        receivedAt: message.receivedAt,
        ...(attachment && { attachments: [attachment] }),
      });
    } catch (error) {
      this.log.error('Telegram message failed', {
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
    }
  }

  /** Downloads the attachment and stores it in the handoff folder; a failure loses the file, not the message. */
  private async storeAttachment(message: TelegramIncoming): Promise<InboundAttachment | undefined> {
    const attachment = message.attachment;
    if (!attachment) return undefined;
    if (!this.handoff) {
      this.log.warn('No handoff folder configured; dropping a Telegram attachment', {
        fileName: attachment.name,
      });
      return undefined;
    }
    try {
      const data = await this.transport.downloadFile(attachment.fileId);
      const saved = await this.handoff.save(attachment.name, data);
      return {
        name: saved.name,
        path: saved.path,
        size: saved.size,
        ...(attachment.mediaType && { mediaType: attachment.mediaType }),
      };
    } catch (error) {
      this.log.warn('Could not store a Telegram attachment', {
        fileName: attachment.name,
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
      return undefined;
    }
  }

  private async clearWorking(chatId: string): Promise<void> {
    const messageId = this.working.get(chatId);
    if (messageId === undefined) return;
    this.working.delete(chatId);
    try {
      await this.transport.deleteMessage(chatId, messageId);
    } catch (error) {
      this.log.warn('Could not remove the working message', {
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
    }
  }
}
