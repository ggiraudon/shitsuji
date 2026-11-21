import { GrammyError, type Bot, InputFile } from 'grammy';
import type { Logger } from '../../ports/Logger.js';

/** A text message as the adapter needs it, independent of grammY's update types. */
export interface TelegramIncoming {
  /** The chat's numeric id, as a string; it is the chat part of a reply channel. */
  chatId: string;
  /** `private`, `group`, `supergroup` or `channel`; the adapter accepts only private chats. */
  chatType: string;
  /** Telegram's id for the message, for replies and edits. */
  messageId: number;
  /** The message text, or the caption of an attachment. */
  text: string;
  /** When Telegram says it was sent. */
  receivedAt: Date;
  /** A document, photo or voice note, downloaded when the adapter stores it. */
  attachment?: TelegramAttachment;
  /** A button press on an approval card (S37). */
  callback?: TelegramCallback;
}

/** A press on an inline keyboard button; `data` is an opaque approval id plus the decision. */
export interface TelegramCallback {
  /** Telegram's callback id, for the answerCallbackQuery toast. */
  id: string;
  /** The button's payload, e.g. `y:<approvalId>` or `n:<approvalId>`. */
  data: string;
  /** The card's message id, so it can be edited once answered. */
  messageId?: number;
}

/** One inline button: what it says, and the payload Telegram sends back when it is pressed. */
export interface TelegramButton {
  /** The label on the button. */
  text: string;
  /** The callback data, kept short: an approval decision and its id. */
  data: string;
}

/** A file the owner sent, as Telegram describes it before the bytes are downloaded. */
export interface TelegramAttachment {
  /** Which kind of upload it was; decides the stored name and media type. */
  kind: 'document' | 'photo' | 'voice';
  /** Telegram's file id, for `downloadFile`. */
  fileId: string;
  /** A name to store it under; Telegram does not always send the original. */
  name: string;
  /** MIME type, when Telegram reports one. */
  mediaType?: string;
  /** Size in bytes, when Telegram reports it. */
  size?: number;
}

/**
 * What the adapter needs from Telegram. Keeping it narrow means the adapter (and its tests) never
 * touch grammY or the network; the grammY implementation is the only place that does (F06, S32).
 */
export interface TelegramTransport {
  /** Starts long polling and hands every accepted update to `onMessage`. */
  start(onMessage: (message: TelegramIncoming) => void): Promise<void>;
  /** Stops polling; the adapter calls it once on shutdown. */
  stop(): Promise<void>;
  /**
   * Sends a message and returns its Telegram id. `plain` is the same chunk as the original Markdown,
   * sent without `parse_mode` when Telegram rejects the HTML (#41).
   */
  sendMessage(chatId: string, html: string, plain: string): Promise<number>;
  /** Replaces a sent message's text, for the "Working…" indicator and edits. */
  editMessage(chatId: string, messageId: number, html: string): Promise<void>;
  /** Removes a message, e.g. the "Working…" line once the reply is delivered. */
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  /** Shows Telegram's "typing" indicator in the chat. */
  sendTyping(chatId: string): Promise<void>;
  /** Sends a card with inline buttons; an approval's data is `y:<id>` or `n:<id>` (S37). */
  sendApproval(chatId: string, html: string, buttons: readonly TelegramButton[]): Promise<number>;
  /** Answers a button press with a short toast, so Telegram stops the spinner. */
  answerCallback(callbackId: string, text: string): Promise<void>;
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
  /** The polling promise, while the bot runs; `stop` awaits it. */
  private running?: Promise<void>;
  /** True once the message handlers were attached, so a second `start` does not attach them again. */
  private registered = false;

  constructor(
    /** The grammY bot; the only object that holds the token. */
    private readonly bot: Bot,
    /** Structured logger for transport failures; the token never reaches it. */
    private readonly log: Logger,
    /** The fetch used to download files, injectable for tests. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // grammY stops polling when a handler throws unless it has a catcher; log and keep going (#42).
    this.bot.catch((error) => {
      this.log.error('Telegram update failed; polling continues', {
        error: {
          name: (error.error as Error | undefined)?.name,
          message: (error.error as Error | undefined)?.message,
        },
      });
    });
  }

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
    this.bot.on('callback_query:data', (ctx) => {
      const callback = ctx.callbackQuery;
      const card = callback.message;
      if (!card) return;
      onMessage({
        chatId: String(card.chat.id),
        chatType: card.chat.type,
        messageId: card.message_id,
        text: '',
        receivedAt: new Date(card.date * 1000),
        callback: {
          id: callback.id,
          data: callback.data,
          messageId: card.message_id,
        },
      });
    });
  }

  /** Starts polling; resolves once Telegram confirms the long-poll loop began. */
  async start(onMessage: (message: TelegramIncoming) => void): Promise<void> {
    this.register(onMessage);
    await new Promise<void>((resolve, reject) => {
      this.running = this.bot.start({
        allowed_updates: ['message', 'callback_query'],
        onStart: () => resolve(),
      });
      this.running.catch(reject);
    });
    this.log.info('Telegram channel started (long polling)');
  }

  /** Stops polling and waits for the loop to end; a failure there is ignored. */
  async stop(): Promise<void> {
    await this.bot.stop();
    await this.running?.catch(() => undefined);
    this.running = undefined;
    this.log.info('Telegram channel stopped');
  }

  /** Sends Markdown-rendered HTML, falling back to the plain text when Telegram rejects the HTML. */
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

  /** Edits a sent message's text in place, with the same HTML rules as `sendMessage`. */
  async editMessage(chatId: string, messageId: number, html: string): Promise<void> {
    await this.bot.api.editMessageText(chatId, messageId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  /** Deletes a message; an already-deleted one is left alone by Telegram's own rules. */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId);
  }

  /** Sends Telegram's typing action, which lasts a few seconds on its own. */
  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing');
  }

  /** Sends the approval card with one row of buttons, and returns its message id. */
  async sendApproval(
    chatId: string,
    html: string,
    buttons: readonly TelegramButton[],
  ): Promise<number> {
    const message = await this.bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          buttons.map((button) => ({ text: button.text, callback_data: button.data })),
        ],
      },
    });
    return message.message_id;
  }

  /** Answers a button press, which stops Telegram's spinner and may show a short toast. */
  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, { text });
  }

  /** Downloads a file's bytes; a failure names the status, never the token-bearing URL. */
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

  /** Uploads bytes as a document, with the owner-visible name and an optional caption. */
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
