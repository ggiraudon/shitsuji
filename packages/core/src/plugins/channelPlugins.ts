import { CLIChannel } from '../adapters/channels/CLIChannel.js';
import { WebhookChannel } from '../adapters/channels/WebhookChannel.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

/** The interactive terminal channel (stdin/stdout). */
export class CliChannelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.cli-channel',
    name: 'CLI channel',
    version: '0.1.0',
    provides: ['channel'],
  } as const;

  register(ctx: PluginRegistrationContext): void {
    ctx.addChannel(new CLIChannel(ctx.log));
  }
}

/** An HTTP endpoint that accepts messages by POST. */
export class WebhookChannelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.webhook-channel',
    name: 'Webhook channel',
    version: '0.1.0',
    provides: ['channel'],
  } as const;

  constructor(private readonly options: { port: number; path: string }) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addChannel(new WebhookChannel(ctx.log, this.options));
  }
}
