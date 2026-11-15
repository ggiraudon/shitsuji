import { logger } from '../adapters/logging/logger.js';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'channel' | 'llm' | 'tool';
  description?: string;
  dependencies?: string[];
}

export interface PluginContext {
  configDir: string;
  dataDir: string;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void>;
  destroy(): Promise<void>;
}

export abstract class BasePlugin implements Plugin {
  abstract readonly manifest: PluginManifest;

  async init(_ctx: PluginContext): Promise<void> {
    logger.info(`Initializing plugin: ${this.manifest.name}`);
  }

  async destroy(): Promise<void> {
    logger.info(`Destroying plugin: ${this.manifest.name}`);
  }
}

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private ctx: PluginContext;

  constructor(configDir: string, dataDir: string) {
    this.ctx = { configDir, dataDir };
  }

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`Plugin ${plugin.manifest.id} already registered`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
    logger.info(`Registered plugin: ${plugin.manifest.name} (${plugin.manifest.type})`);
  }

  async unregister(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (plugin) {
      await plugin.destroy();
      this.plugins.delete(id);
      logger.info(`Unregistered plugin: ${id}`);
    }
  }

  async initializeAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.init(this.ctx);
    }
  }

  async destroyAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.destroy();
    }
    this.plugins.clear();
  }

  get<T extends Plugin>(id: string): T | undefined {
    return this.plugins.get(id) as T;
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  listByType(type: PluginManifest['type']): Plugin[] {
    return this.list().filter((p) => p.manifest.type === type);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }
}
