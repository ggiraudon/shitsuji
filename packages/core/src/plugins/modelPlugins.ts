import { AnthropicProvider } from '../adapters/models/AnthropicProvider.js';
import { OpenAICompatibleProvider } from '../adapters/models/OpenAICompatibleProvider.js';
import type { Secret } from '../domain/Secret.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

/** One configured endpoint, as given by models.providers in the configuration. */
export interface ModelEndpoint {
  id: string;
  baseUrl?: string;
  apiKey?: Secret;
  headers?: Record<string, string>;
  quirks?: Record<string, unknown>;
}

/** Registers one OpenAI-compatible provider per endpoint (DeepSeek, OpenRouter, Ollama, …). */
export class OpenAICompatiblePlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.openai-compatible',
    name: 'OpenAI-compatible models',
    version: '0.2.0',
    provides: ['model'],
  } as const;

  constructor(private readonly endpoints: readonly ModelEndpoint[]) {}

  register(ctx: PluginRegistrationContext): void {
    for (const e of this.endpoints) {
      ctx.addModelProvider(
        new OpenAICompatibleProvider({
          id: e.id,
          baseUrl: e.baseUrl ?? 'https://api.openai.com/v1',
          apiKey: e.apiKey?.reveal(),
          headers: e.headers,
          quirks: e.quirks,
          log: ctx.log.child({ provider: e.id }),
        }),
      );
    }
  }
}

/** Registers one Anthropic provider per endpoint. */
export class AnthropicPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.anthropic',
    name: 'Anthropic models',
    version: '0.2.0',
    provides: ['model'],
  } as const;

  constructor(private readonly endpoints: readonly ModelEndpoint[]) {}

  register(ctx: PluginRegistrationContext): void {
    for (const e of this.endpoints) {
      if (!e.apiKey) throw new Error(`Anthropic provider "${e.id}" has no apiKey`);
      ctx.addModelProvider(
        new AnthropicProvider({
          id: e.id,
          apiKey: e.apiKey.reveal(),
          baseUrl: e.baseUrl,
          log: ctx.log.child({ provider: e.id }),
        }),
      );
    }
  }
}
