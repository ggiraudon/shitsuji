import { GrammyError, type Bot, InputFile } from 'grammy';
import type { Logger } from '../../ports/Logger.js';

/** A text message as the adapter needs it, independent of grammY's update types. */
export interface TelegramIncoming {
  chatId: string;
  /** `private`, `group`, `supergroup` or `channel`; the adapter accepts only private chats. */
  chatType: string;
  messageId: number;
  text: string;
  receivedAt: Date;
  /** A document, photo or voice note, downloaded when the adapter stores it. */
  attachment?: TelegramAttachment;
}

export interface TelegramAttachment {
  kind: 'document' | 'photo' | 'voice';
  fileId: string;
  name: string;
  mediaType?: string;
  size?: number;
}

/**
 * What the adapter needs from Telegram. Keeping it narrow means the adapter (and its tests) never
 * touch grammY or the network; the grammY implementation is the only place that does (F06, S32).
 */
export interface TelegramTransport {
  start(onMessage: (message: TelegramIncoming) => void): Promise<void>;
  stop(): Promise<void>;
  /**
   * Sends a message and returns its Telegram id. `plain` is the same chunk as the original Markdown,
   * sent without `parse_mode` when Telegram rejects the HTML (#41).
   */
  sendMessage(chatId: string, html: string, plain: string): Promise<number>;
  editMessage(chatId: string, messageId: number, html: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  /** Downloads a file the owner sent. */
  downloadFile(fileId: string): Promise<Uint8Array>;
  /** Sends a file as a Telegram document and returns its Telegram id. */
  sendDocument(
    chatId: string,
    fileName: string,
    data: Uint8Array,
    caption?: string,
  ): Promise<number>;
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
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Attaches the message handlers without starting polling; tests use bot.handleUpdate(). */
  register(onMessage: (message: TelegramIncoming) => void): void {
    if (this.registered) return;
    this.registered = true;
    this.bot.on('message:text', (ctx) => {
      onMessage(baseOf(ctx, ctx.message.text));
    });
    this.bot.on('message:document', (ctx) => {
      const document = ctx.message.document;
      onMessage({
        ...baseOf(ctx, ctx.message.caption ?? ''),
        attachment: {
          kind: 'document',
          fileId: document.file_id,
          name: document.file_name ?? `document-${document.file_unique_id}`,
          ...(document.mime_type && { mediaType: document.mime_type }),
          ...(document.file_size && { size: document.file_size }),
        },
      });
    });
    this.bot.on('message:photo', (ctx) => {
      const photo = ctx.message.photo.at(-1)!;
      onMessage({
        ...baseOf(ctx, ctx.message.caption ?? ''),
        attachment: {
          kind: 'photo',
          fileId: photo.file_id,
          name: `photo-${photo.file_unique_id}.jpg`,
          mediaType: 'image/jpeg',
          ...(photo.file_size && { size: photo.file_size }),
        },
      });
    });
    this.bot.on('message:voice', (ctx) => {
      const voice = ctx.message.voice;
      onMessage({
        ...baseOf(ctx, ''),
        attachment: {
          kind: 'voice',
          fileId: voice.file_id,
          name: `voice-${voice.file_unique_id}.ogg`,
          mediaType: voice.mime_type ?? 'audio/ogg',
          ...(voice.file_size && { size: voice.file_size }),
        },
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

  async sendMessage(chatId: string, html: string, plain: string): Promise<number> {
    try {
      const message = await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return message.message_id;
    } catch (error) {
      if (!isParseError(error)) throw error;
      // Odd Markdown can render to HTML Telegram refuses; the owner still gets the reply (#41).
      this.log.warn('Telegram rejected the message HTML; sending it as plain text');
      const message = await this.bot.api.sendMessage(chatId, plain, {
        link_preview_options: { is_disabled: true },
      });
      return message.message_id;
    }
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

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return a file path');
    // The token is in this URL; never put the URL in an error or a log.
    const response = await this.fetchImpl(
      `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`,
    );
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async sendDocument(
    chatId: string,
    fileName: string,
    data: Uint8Array,
    caption?: string,
  ): Promise<number> {
    const message = await this.bot.api.sendDocument(chatId, new InputFile(data, fileName), {
      ...(caption && { caption }),
    });
    return message.message_id;
  }
}

/** True when Telegram refused the message because it could not parse its HTML. */
function isParseError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /can't parse entities/i.test(error.description)
  );
}

/** The parts every message update shares. */
function baseOf(
  ctx: { chat: { id: number; type: string }; message: { message_id: number; date: number } },
  text: string,
): TelegramIncoming {
  return {
    chatId: String(ctx.chat.id),
    chatType: ctx.chat.type,
    messageId: ctx.message.message_id,
    text,
    receivedAt: new Date(ctx.message.date * 1000),
  };
}
