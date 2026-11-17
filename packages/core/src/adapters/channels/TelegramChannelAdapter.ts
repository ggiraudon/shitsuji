import fs from 'node:fs/promises';
import type { Logger } from '../../ports/Logger.js';
import type {
  ChannelCapabilities,
  ChannelTarget,
  DeliveryReceipt,
  InboundAttachment,
  InboundSink,
  OutboundMessage,
  OutboundPart,
} from '../../ports/ChannelAdapter.js';
import { BaseChannelAdapter } from '../../ports/ChannelAdapter.js';
import type { HandoffStore } from '../files/HandoffStore.js';
import type { TelegramIncoming, TelegramTransport } from './TelegramTransport.js';
import { escapeHtml, TelegramRenderer } from './TelegramRenderer.js';

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
    buttons: true,
    files: true,
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
    const files = message.parts.filter(
      (part): part is Extract<OutboundPart, { kind: 'file' }> => part.kind === 'file',
    );
    const approvals = message.parts.filter(
      (part): part is Extract<OutboundPart, { kind: 'approval' }> => part.kind === 'approval',
    );
    const textMessage: OutboundMessage = {
      ...message,
      parts: message.parts.filter((part) => part.kind !== 'file' && part.kind !== 'approval'),
    };
    const { chunks, degraded } = this.renderer.render(textMessage);
    if (degraded.length) {
      this.log.debug('Telegram degraded message parts to text', { parts: degraded });
    }
    let first: number | undefined;
    for (const chunk of chunks) {
      const messageId = await this.transport.sendMessage(target.chatId, chunk.html, chunk.plain);
      first ??= messageId;
    }
    for (const part of approvals) {
      const messageId = await this.transport.sendApproval(
        target.chatId,
        `🔐 <b>Approval needed</b>\n${escapeHtml(part.summary)}`,
        [
          { text: part.actionLabel, data: `y:${part.approvalId}` },
          { text: 'Decline', data: `n:${part.approvalId}` },
        ],
      );
      first ??= messageId;
    }
    for (const part of files) {
      if (!part.fileRef.path) {
        this.log.warn('A Telegram file has no local path; skipping it', {
          fileName: part.fileRef.name,
        });
        continue;
      }
      try {
        const data = await fs.readFile(part.fileRef.path);
        const messageId = await this.transport.sendDocument(
          target.chatId,
          part.fileRef.name,
          data,
          part.caption,
        );
        first ??= messageId;
      } catch (error) {
        this.log.warn('Could not send a Telegram document', {
          fileName: part.fileRef.name,
          error: { name: (error as Error)?.name, message: (error as Error)?.message },
        });
      }
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
      const messageId = await this.transport.sendMessage(target.chatId, 'Working…', 'Working…');
      this.working.set(target.chatId, messageId);
    } catch (error) {
      this.log.warn('Could not show Telegram typing', {
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
    }
  }

  private async onMessage(message: TelegramIncoming): Promise<void> {
    if (!this.sink) return;
    // Pairing binds a chat; on Telegram a group would let every member act as the owner (F06, #38).
    if (message.chatType !== 'private') {
      this.log.debug('Ignoring a Telegram message from a non-private chat', {
        chatType: message.chatType,
      });
      return;
    }
    try {
      if (message.callback) {
        await this.onCallback(message, message.callback);
        return;
      }
      // Ask the gateway before downloading: an unpaired chat must not fill the handoff folder (#44).
      const accepted =
        message.attachment && this.sink.accepts
          ? await this.sink.accepts({ channel: this.id, chatId: message.chatId })
          : true;
      if (message.attachment?.kind === 'voice') {
        if (!accepted) {
          this.log.debug('Ignoring a voice note from a chat that cannot start a turn');
          return;
        }
        // Keep the file for F23, but do not start a turn the agent cannot hear.
        await this.storeAttachment(message);
        await this.transport.sendMessage(
          message.chatId,
          "I can't listen to voice notes yet.",
          "I can't listen to voice notes yet.",
        );
        return;
      }
      const attachment =
        message.attachment && accepted ? await this.storeAttachment(message) : undefined;
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

  /** A button press on an approval card: the gateway answers it, then the card is updated (S37). */
  private async onCallback(
    message: TelegramIncoming,
    callback: NonNullable<TelegramIncoming['callback']>,
  ): Promise<void> {
    if (!this.sink) return;
    try {
      const result = await this.sink.receive({
        channel: this.id,
        chatId: message.chatId,
        text: '',
        externalId: String(message.messageId),
        receivedAt: message.receivedAt,
        callback: {
          id: callback.id,
          data: callback.data,
          ...(callback.messageId !== undefined && { messageId: String(callback.messageId) }),
        },
      });
      const reason = result.kind === 'replied' ? result.reason : undefined;
      const approved = reason === 'approved';
      const declined = reason === 'declined';
      await this.transport.answerCallback(
        callback.id,
        approved ? 'Approved.' : declined ? 'Declined.' : 'This card is no longer open.',
      );
      if (callback.messageId !== undefined && (approved || declined)) {
        await this.transport.editMessage(
          message.chatId,
          callback.messageId,
          approved ? '✅ Approved.' : '❌ Declined.',
        );
      }
    } catch (error) {
      this.log.error('Telegram button press failed', {
        error: { name: (error as Error)?.name, message: (error as Error)?.message },
      });
      await this.transport.answerCallback(callback.id, 'Something went wrong.').catch(() => {});
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
