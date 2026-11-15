import { AnthropicProvider } from '../adapters/models/AnthropicProvider.js';
import { OpenAIProvider } from '../adapters/models/OpenAIProvider.js';
import type { Secret } from '../domain/Secret.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

/** One configured endpoint, as given by models.providers in the configuration. */
export interface ModelEndpoint {
  id: string;
  baseUrl?: string;
  apiKey?: Secret;
}

/** Registers one OpenAI-compatible provider per endpoint (DeepSeek, OpenRouter, Ollama, …). */
export class OpenAICompatiblePlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.openai-compatible',
    name: 'OpenAI-compatible models',
    version: '0.1.0',
    provides: ['model'],
  } as const;

  constructor(private readonly endpoints: readonly ModelEndpoint[]) {}

  register(ctx: PluginRegistrationContext): void {
    for (const e of this.endpoints) {
      ctx.addModelProvider(
        e.id,
        new OpenAIProvider(e.apiKey?.reveal() ?? '', ctx.log, { baseUrl: e.baseUrl }),
      );
    }
  }
}

/** Registers one Anthropic provider per endpoint. */
export class AnthropicPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.anthropic',
    name: 'Anthropic models',
    version: '0.1.0',
    provides: ['model'],
  } as const;

  constructor(private readonly endpoints: readonly ModelEndpoint[]) {}

  register(ctx: PluginRegistrationContext): void {
    for (const e of this.endpoints) {
      if (!e.apiKey) throw new Error(`Anthropic provider "${e.id}" has no apiKey`);
      ctx.addModelProvider(
        e.id,
        new AnthropicProvider(e.apiKey.reveal(), ctx.log, { baseUrl: e.baseUrl }),
      );
    }
  }
}
