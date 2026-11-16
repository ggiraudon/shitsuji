import type { Logger } from '../../ports/Logger.js';
import type {
  ChannelCapabilities,
  ChannelTarget,
  DeliveryReceipt,
  InboundSink,
  OutboundMessage,
} from '../../ports/ChannelAdapter.js';
import { BaseChannelAdapter } from '../../ports/ChannelAdapter.js';
import type { TelegramIncoming, TelegramTransport } from './TelegramTransport.js';
import { TelegramRenderer } from './TelegramRenderer.js';

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

  constructor(
    private readonly transport: TelegramTransport,
    private readonly log: Logger,
    private readonly renderer = new TelegramRenderer(),
  ) {
    super();
  }

  override async start(sink: InboundSink): Promise<void> {
    await super.start(sink);
    await this.transport.start((message) => this.onMessage(message));
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

  private onMessage(message: TelegramIncoming): void {
    if (!this.sink) return;
    void this.sink
      .receive({
        channel: this.id,
        chatId: message.chatId,
        text: message.text,
        externalId: String(message.messageId),
        receivedAt: message.receivedAt,
      })
      .catch((error: unknown) => {
        this.log.error('Telegram message failed', {
          error: { name: (error as Error)?.name, message: (error as Error)?.message },
        });
      });
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
