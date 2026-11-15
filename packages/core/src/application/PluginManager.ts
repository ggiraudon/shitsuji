import { ShitsujiError, serializeError } from '../domain/errors.js';
import type { Channel } from '../ports/Channel.js';
import type { ContextInjectable } from '../ports/ContextInjectable.js';
import type { EventBus } from '../ports/EventBus.js';
import type { ModelProvider } from '../ports/ModelProvider.js';
import type { Logger } from '../ports/Logger.js';
import type {
  PluginCapability,
  PluginRegistrationContext,
  ShitsujiPlugin,
} from '../ports/Plugin.js';
import type { Tool } from '../ports/LegacyTool.js';

export class PluginError extends ShitsujiError {
  override readonly name = 'PluginError';
  constructor(pluginId: string, message: string, options?: { cause?: unknown }) {
    super('plugin_failed', `Plugin ${pluginId}: ${message}`, { pluginId }, options);
  }
}

export interface PluginManagerOptions {
  log: Logger;
  events: EventBus;
  /** plugins.settings from the configuration, keyed by plugin id. */
  settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Loads plugins and collects what they register. The single mechanism for adding model providers,
 * channels, tools and context injectables. Names must be unique across all plugins.
 */
export class PluginManager {
  private readonly loaded: ShitsujiPlugin[] = [];
  private readonly modelProviders = new Map<string, ModelProvider>();
  private readonly channelList: Channel[] = [];
  private readonly toolList: Tool[] = [];
  private readonly injectableList: ContextInjectable[] = [];
  private readonly owners = new Map<string, string>(); // "kind:name" -> plugin id

  constructor(private readonly options: PluginManagerOptions) {}

  async load(plugins: readonly ShitsujiPlugin[]): Promise<void> {
    for (const plugin of plugins) await this.loadOne(plugin);
  }

  providers(): ReadonlyMap<string, ModelProvider> {
    return this.modelProviders;
  }

  channels(): readonly Channel[] {
    return this.channelList;
  }

  tools(): readonly Tool[] {
    return this.toolList;
  }

  injectables(): readonly ContextInjectable[] {
    return this.injectableList;
  }

  plugins(): readonly ShitsujiPlugin[] {
    return this.loaded;
  }

  /** Disposes plugins in reverse load order. Failures are logged, never thrown, so all get a turn. */
  async disposeAll(): Promise<void> {
    for (const plugin of [...this.loaded].reverse()) {
      try {
        await plugin.dispose?.();
      } catch (error) {
        this.options.log.error('Plugin dispose failed', {
          plugin: plugin.manifest.id,
          error: serializeError(error),
        });
      }
    }
    this.loaded.length = 0;
  }

  private async loadOne(plugin: ShitsujiPlugin): Promise<void> {
    const { id } = plugin.manifest;
    if (this.loaded.some((p) => p.manifest.id === id)) {
      throw new PluginError(id, 'is already loaded');
    }
    const log = this.options.log.child({ plugin: id });
    const provides = new Set(plugin.manifest.provides);
    const require = (capability: PluginCapability, what: string) => {
      if (!provides.has(capability)) {
        throw new PluginError(
          id,
          `registered ${what} but its manifest does not provide "${capability}"`,
        );
      }
    };
    const claim = (kind: string, name: string) => {
      const key = `${kind}:${name}`;
      const owner = this.owners.get(key);
      if (owner) throw new PluginError(id, `${kind} "${name}" is already registered by ${owner}`);
      this.owners.set(key, id);
    };

    // Collect first and commit only if register() succeeds, so a failing plugin leaves nothing behind.
    const pending = {
      providers: [] as [string, ModelProvider][],
      channels: [] as Channel[],
      tools: [] as Tool[],
      injectables: [] as ContextInjectable[],
      claims: [] as string[],
    };
    const track = (kind: string, name: string) => {
      claim(kind, name);
      pending.claims.push(`${kind}:${name}`);
    };
    const ctx: PluginRegistrationContext = {
      config: this.options.settings?.[id] ?? {},
      log,
      events: this.options.events,
      addModelProvider: (provider) => {
        const providerId = provider.id;
        require('model', `model provider "${providerId}"`);
        track('model provider', providerId);
        pending.providers.push([providerId, provider]);
      },
      addChannel: (channel) => {
        require('channel', `channel "${channel.name}"`);
        track('channel', channel.name);
        pending.channels.push(channel);
      },
      addTools: (tools) => {
        for (const tool of tools) {
          require('tools', `tool "${tool.name}"`);
          track('tool', tool.name);
          pending.tools.push(tool);
        }
      },
      addContextInjectable: (injectable) => {
        require('context', `context injectable "${injectable.id}"`);
        pending.injectables.push(injectable);
      },
    };

    try {
      await plugin.register(ctx);
    } catch (error) {
      for (const key of pending.claims) this.owners.delete(key);
      if (error instanceof PluginError) throw error;
      throw new PluginError(
        id,
        `register() failed: ${(error as Error)?.message ?? String(error)}`,
        {
          cause: error,
        },
      );
    }

    for (const [providerId, provider] of pending.providers) {
      this.modelProviders.set(providerId, provider);
    }
    this.channelList.push(...pending.channels);
    this.toolList.push(...pending.tools);
    this.injectableList.push(...pending.injectables);
    this.loaded.push(plugin);
    log.info('Plugin loaded', {
      version: plugin.manifest.version,
      providers: pending.providers.map(([p]) => p),
      channels: pending.channels.map((c) => c.name),
      tools: pending.tools.length,
    });
  }
}
