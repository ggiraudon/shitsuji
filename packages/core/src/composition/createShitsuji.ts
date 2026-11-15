import { InMemoryRepositories } from '../adapters/memory/InMemoryRepositories.js';
import { PostgresDatabase } from '../adapters/postgres/PostgresDatabase.js';
import { PostgresRepositories } from '../adapters/postgres/PostgresRepositories.js';
import { Agent } from '../application/Agent.js';
import { PluginManager } from '../application/PluginManager.js';
import { ConfigError } from '../domain/errors.js';
import { asId, type OwnerId } from '../domain/model/ids.js';
import type { Repositories } from '../ports/Repositories.js';
import type { ShitsujiPlugin } from '../ports/Plugin.js';
import { CliChannelPlugin, WebhookChannelPlugin } from '../plugins/channelPlugins.js';
import { CoreToolsPlugin } from '../plugins/coreToolsPlugin.js';
import { AnthropicPlugin, OpenAICompatiblePlugin } from '../plugins/modelPlugins.js';
import type { ShitsujiConfig } from './config/schema.js';
import { loadPluginsFromDirectory } from './loadPluginsFromDirectory.js';
import { createCoreServices, type CoreServices } from './services.js';
import { Shitsuji } from './Shitsuji.js';

export const VERSION = '0.1.0';

/** Shitsuji has one owner (05-open-questions P1); every row still carries owner_id. */
export const OWNER_ID: OwnerId = asId('owner');

function inMemoryWithWarning(log: CoreServices['log']): Repositories {
  log.warn('No database configured: conversations are kept in memory and lost on restart');
  return new InMemoryRepositories();
}

export interface CreateShitsujiOptions {
  /** Defaults to services built from config.logging. */
  services?: CoreServices;
  /** Load the CLI and webhook channels (if enabled in config). The TUI turns this off. */
  channels?: boolean;
  /** Storage. Defaults to Postgres when database.url is set (S9), else in memory. */
  repos?: Repositories;
  /** Extra plugins, loaded after the built-ins and before the plugins directory. */
  plugins?: readonly ShitsujiPlugin[];
}

/**
 * The composition root: turns a validated configuration into the running object graph. This and the
 * other files in composition/ are the only places that construct adapters.
 */
export async function createShitsuji(
  config: ShitsujiConfig,
  options: CreateShitsujiOptions = {},
): Promise<Shitsuji> {
  const services = options.services ?? createCoreServices(config.logging);
  const { log, events } = services;

  const plugins = new PluginManager({ log, events, settings: config.plugins.settings });
  await plugins.load(builtInPlugins(config, options.channels ?? true));
  await plugins.load(options.plugins ?? []);
  if (config.plugins.directory) {
    await plugins.load(await loadPluginsFromDirectory(config.plugins.directory, log));
  }

  const onStop: (() => Promise<void>)[] = [];
  let repos = options.repos;
  if (!repos && config.database.url) {
    const database = PostgresDatabase.connect({ url: config.database.url.reveal(), log });
    onStop.push(() => database.close());
    try {
      await database.migrate();
    } catch (error) {
      await database.close();
      throw new ConfigError(
        `Cannot use the database at database.url: ${(error as Error).message}`,
        {},
        { cause: error },
      );
    }
    repos = new PostgresRepositories(database.db);
    log.info('Using Postgres');
  }
  repos ??= inMemoryWithWarning(log);
  await repos.owners.upsert({
    id: OWNER_ID,
    displayName: config.owner.name,
    timezone: config.owner.timezone,
    locale: config.owner.locale,
  });

  const chat = resolveChatModel(config, plugins);
  log.info('Using chat model', { model: chat.ref });
  const agent = new Agent({
    name: 'Shitsuji',
    llmProvider: chat.provider,
    model: chat.model,
    ownerId: OWNER_ID,
    repos,
    clock: services.clock,
    log,
    events,
  });
  for (const tool of plugins.tools()) agent.registerTool(tool);
  for (const injectable of plugins.injectables()) agent.addInjectable(injectable);

  return new Shitsuji({
    agent,
    channels: plugins.channels(),
    plugins,
    log,
    events,
    version: VERSION,
    onStop,
  });
}

function builtInPlugins(config: ShitsujiConfig, withChannels: boolean): ShitsujiPlugin[] {
  const endpoints = (kind: 'openai-compatible' | 'anthropic') =>
    Object.entries(config.models.providers)
      .filter(([, p]) => p.kind === kind)
      .map(([id, p]) => ({ id, baseUrl: p.baseUrl, apiKey: p.apiKey }));

  const list: ShitsujiPlugin[] = [
    new OpenAICompatiblePlugin(endpoints('openai-compatible')),
    new AnthropicPlugin(endpoints('anthropic')),
    new CoreToolsPlugin(),
  ];
  if (withChannels && config.channels.cli.enabled) list.push(new CliChannelPlugin());
  if (withChannels && config.channels.webhook.enabled) {
    list.push(new WebhookChannelPlugin(config.channels.webhook));
  }
  return list;
}

/** Picks the provider for the `chat` purpose. Replaced by the ModelRouter in S13. */
function resolveChatModel(config: ShitsujiConfig, plugins: PluginManager) {
  const ref = config.models.purposes.chat;
  if (!ref) {
    throw new ConfigError(
      'No chat model configured. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) in .env, ' +
        'or add models.providers and models.purposes.chat to shitsuji.config.yaml.',
    );
  }
  const slash = ref.indexOf('/');
  const providerId = ref.slice(0, slash);
  const provider = plugins.providers().get(providerId);
  if (!provider) {
    throw new ConfigError(
      `models.purposes.chat uses provider "${providerId}", but no plugin registered it`,
    );
  }
  return { provider, model: ref.slice(slash + 1), ref };
}
