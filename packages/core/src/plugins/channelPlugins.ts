import { WebhookChannelAdapter } from '../adapters/channels/WebhookChannelAdapter.js';
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
