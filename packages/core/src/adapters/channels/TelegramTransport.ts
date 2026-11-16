import { type Bot } from 'grammy';
import type { Logger } from '../../ports/Logger.js';

/** A text message as the adapter needs it, independent of grammY's update types. */
export interface TelegramIncoming {
  chatId: string;
  messageId: number;
  text: string;
  receivedAt: Date;
}

/**
 * What the adapter needs from Telegram. Keeping it narrow means the adapter (and its tests) never
 * touch grammY or the network; the grammY implementation is the only place that does (F06, S32).
 */
export interface TelegramTransport {
  start(onMessage: (message: TelegramIncoming) => void): Promise<void>;
  stop(): Promise<void>;
  /** Sends an HTML message and returns its Telegram id. */
  sendMessage(chatId: string, html: string): Promise<number>;
  editMessage(chatId: string, messageId: number, html: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}

/**
 * grammY over long polling. The bot token is only given to grammY here; it is never logged. Errors are
 * reduced to their message, because grammY's URLs contain the token (F06, S32).
 */
export class GrammyTelegramTransport implements TelegramTransport {
  private running?: Promise<void>;
  private registered = false;

  constructor(
    private readonly bot: Bot,
    private readonly log: Logger,
  ) {}

  /** Attaches the message handler without starting polling; tests use bot.handleUpdate(). */
  register(onMessage: (message: TelegramIncoming) => void): void {
    if (this.registered) return;
    this.registered = true;
    this.bot.on('message:text', (ctx) => {
      onMessage({
        chatId: String(ctx.chat.id),
        messageId: ctx.message.message_id,
        text: ctx.message.text,
        receivedAt: new Date(ctx.message.date * 1000),
      });
    });
  }

  async start(onMessage: (message: TelegramIncoming) => void): Promise<void> {
    this.register(onMessage);
    await new Promise<void>((resolve, reject) => {
      this.running = this.bot.start({
        allowed_updates: ['message'],
        onStart: () => resolve(),
      });
      this.running.catch(reject);
    });
    this.log.info('Telegram channel started (long polling)');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await this.running?.catch(() => undefined);
    this.running = undefined;
    this.log.info('Telegram channel stopped');
  }

  async sendMessage(chatId: string, html: string): Promise<number> {
    const message = await this.bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return message.message_id;
  }

  async editMessage(chatId: string, messageId: number, html: string): Promise<void> {
    await this.bot.api.editMessageText(chatId, messageId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId);
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing');
  }
}
