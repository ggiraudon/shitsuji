import type { ChannelAdapter } from './ChannelAdapter.js';
import type { ContextInjectable } from './ContextInjectable.js';
import type { EventBus } from './EventBus.js';
import type { Logger } from './Logger.js';
import type { ModelProvider } from './ModelProvider.js';
import type { Tool } from './Tool.js';

export type PluginCapability = 'model' | 'channel' | 'tools' | 'context';

export interface PluginManifest {
  /** Stable, unique id, e.g. "builtin.openai-compatible". */
  id: string;
  name: string;
  version: string;
  /** What the plugin may register. Registering anything else is an error. */
  provides: readonly PluginCapability[];
  description?: string;
}

/**
 * The only way a plugin reaches the core. Plugins never import core internals; they receive this
 * context, register what their manifest says they provide, and get their own config section.
 */
export interface PluginRegistrationContext {
  /** This plugin's section of the configuration (plugins.settings.<id>), or {} if absent. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly log: Logger;
  readonly events: EventBus;
  /** Registers a model provider under its id, which model refs use ("deepseek" in "deepseek/…"). */
  addModelProvider(provider: ModelProvider): void;
  addChannel(channel: ChannelAdapter): void;
  addTools(tools: readonly Tool[]): void;
  addContextInjectable(injectable: ContextInjectable): void;
}

export interface ShitsujiPlugin {
  readonly manifest: PluginManifest;
  register(ctx: PluginRegistrationContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
