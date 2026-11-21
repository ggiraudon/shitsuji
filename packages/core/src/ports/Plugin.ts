import type { ChannelAdapter } from './ChannelAdapter.js';
import type { ContextInjectable } from './ContextInjectable.js';
import type { EventBus } from './EventBus.js';
import type { Logger } from './Logger.js';
import type { ModelProvider } from './ModelProvider.js';
import type { Tool } from './Tool.js';

/** What a plugin may register; the registration context only offers these. */
export type PluginCapability = 'model' | 'channel' | 'tools' | 'context';

/** What a plugin declares about itself: its id, version and the capabilities it will register. */
export interface PluginManifest {
  /** Stable, unique id, e.g. "builtin.openai-compatible". */
  id: string;
  /** A human name for status pages and logs. */
  name: string;
  /** The plugin version, for the manifest and the `/status` report. */
  version: string;
  /** What the plugin may register. Registering anything else is an error. */
  provides: readonly PluginCapability[];
  /** One line on what the plugin does, for a listing. */
  description?: string;
}

/**
 * The only way a plugin reaches the core. Plugins never import core internals; they receive this
 * context, register what their manifest says they provide, and get their own config section.
 *
 * Registration is staged: `PluginManager` collects what `register` adds and commits it only if
 * `register` succeeds, so a failing plugin leaves nothing half-registered. Registering a capability the
 * manifest does not list, or a name another plugin already claimed, throws instead.
 */
export interface PluginRegistrationContext {
  /** This plugin's section of the configuration (plugins.settings.<id>), or {} if absent. */
  readonly config: Readonly<Record<string, unknown>>;
  /** A logger already bound with the plugin's id. */
  readonly log: Logger;
  /** The process bus, so the plugin can publish events the UI already understands. */
  readonly events: EventBus;
  /** Registers a model provider under its id, which model refs use ("deepseek" in "deepseek/…"). */
  addModelProvider(provider: ModelProvider): void;
  /** Registers a channel; `Shitsuji.start` starts it with the others in registry order. */
  addChannel(channel: ChannelAdapter): void;
  /** Registers tools in the live catalog; the next model request sees them. */
  addTools(tools: readonly Tool[]): void;
  /** Adds context injectables; a running turn keeps the context it already assembled. */
  addContextInjectable(injectable: ContextInjectable): void;
}

/**
 * One plugin, loaded by `PluginManager`. `register` runs once at startup and must only use the
 * context; `dispose` runs on shutdown and should release timers, sockets and files it opened.
 */
export interface ShitsujiPlugin {
  /** What the plugin is and may register; read before `register` runs. */
  readonly manifest: PluginManifest;
  /** Registers providers, channels, tools or injectables; may be async. Failures abort the load. */
  register(ctx: PluginRegistrationContext): Promise<void> | void;
  /** Releases what `register` opened; failures are logged and do not block the shutdown. */
  dispose?(): Promise<void> | void;
}
