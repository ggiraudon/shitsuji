import { Bot } from 'grammy';
import { WebhookChannelAdapter } from '../adapters/channels/WebhookChannelAdapter.js';
import { TelegramChannelAdapter } from '../adapters/channels/TelegramChannelAdapter.js';
import { GrammyTelegramTransport } from '../adapters/channels/TelegramTransport.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

export interface WebhookChannelPluginOptions {
  host: string;
  port: number;
  path: string;
  /** Checks the owner key from `Authorization: Bearer` (#34). */
  authorize: (key: string | undefined) => boolean;
}

/** An HTTP endpoint that accepts messages by POST, with the owner key, and answers with the reply. */
export class WebhookChannelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.webhook-channel',
    name: 'Webhook channel',
    version: '0.1.0',
    provides: ['channel'],
  } as const;

  constructor(private readonly options: WebhookChannelPluginOptions) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addChannel(new WebhookChannelAdapter(ctx.log, this.options));
  }
}

export interface TelegramChannelPluginOptions {
  /** The token from @BotFather. Composition reveals it; the plugin never logs it (F06, S32). */
  token: string;
}

/** Telegram through grammY with long polling (decision T1). */
export class TelegramChannelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.telegram-channel',
    name: 'Telegram channel',
    version: '0.1.0',
    provides: ['channel'],
  } as const;

  constructor(private readonly options: TelegramChannelPluginOptions) {}

  register(ctx: PluginRegistrationContext): void {
    const bot = new Bot(this.options.token);
    ctx.addChannel(new TelegramChannelAdapter(new GrammyTelegramTransport(bot, ctx.log), ctx.log));
  }
}
