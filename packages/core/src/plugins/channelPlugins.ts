import { WebhookChannelAdapter } from '../adapters/channels/WebhookChannelAdapter.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

/** An HTTP endpoint that accepts messages by POST and answers with the reply. */
export class WebhookChannelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.webhook-channel',
    name: 'Webhook channel',
    version: '0.1.0',
    provides: ['channel'],
  } as const;

  constructor(private readonly options: { port: number; path: string }) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addChannel(new WebhookChannelAdapter(ctx.log, this.options));
  }
}
