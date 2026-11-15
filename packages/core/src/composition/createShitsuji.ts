import path from 'node:path';
import { OwnerKeyFile } from '../adapters/auth/OwnerKeyFile.js';
import { InMemoryJobQueue } from '../adapters/jobs/InMemoryJobQueue.js';
import { PgBossJobQueue } from '../adapters/jobs/PgBossJobQueue.js';
import { InMemoryRepositories } from '../adapters/memory/InMemoryRepositories.js';
import { PostgresDatabase } from '../adapters/postgres/PostgresDatabase.js';
import { PostgresRepositories } from '../adapters/postgres/PostgresRepositories.js';
import { Agent } from '../application/Agent.js';
import { SoulService } from '../application/soul/SoulService.js';
import { NodeTextFile } from '../adapters/files/NodeTextFile.js';
import {
  MeteredModelProvider,
  RedactingModelProvider,
  RetryingModelProvider,
} from '../application/models/decorators.js';
import { ModelCatalog } from '../application/models/ModelCatalog.js';
import { ModelRouter, NoModelAvailable } from '../application/models/ModelRouter.js';
import { PluginManager } from '../application/PluginManager.js';
import { defaultMiddlewares } from '../application/tools/middlewares.js';
import { ToolCatalog } from '../application/tools/ToolCatalog.js';
import { ToolPipeline } from '../application/tools/ToolPipeline.js';
import { ToolCallGateway } from '../application/tools/ToolCallGateway.js';
import { ToolSearchTool } from '../application/tools/ToolSearchTool.js';
import { StartupRecovery } from '../application/StartupRecovery.js';
import type { JobQueue } from '../ports/JobQueue.js';
import { ConfigError, serializeError } from '../domain/errors.js';
import { asId, type OwnerId } from '../domain/model/ids.js';
import { Money } from '../domain/model/Money.js';
import type { Repositories } from '../ports/Repositories.js';
import type { ShitsujiPlugin } from '../ports/Plugin.js';
import { WebhookChannelPlugin } from '../plugins/channelPlugins.js';
import { CoreToolsPlugin } from '../plugins/coreToolsPlugin.js';
import { WebToolsPlugin } from '../plugins/webToolsPlugin.js';
import { AnthropicPlugin, OpenAICompatiblePlugin } from '../plugins/modelPlugins.js';
import type { ShitsujiConfig } from './config/schema.js';
import { startApiServer } from './apiServer.js';
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
  /** Load the webhook channel (if enabled in config). Tests turn this off. */
  channels?: boolean;
  /** Storage. Defaults to Postgres when database.url is set (S9), else in memory. */
  repos?: Repositories;
  /** Start the HTTP API (default: config.api.enabled). The in-process tests turn it off. */
  api?: boolean;
  /** Background jobs. Defaults to pg-boss with Postgres, else in memory. */
  jobs?: JobQueue;
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
  // system.status reads these at call time; they are filled in once the graph is built.
  const startedAt = Date.now();
  const facts: Record<string, unknown> = {};
  const status = async () => ({
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...facts,
  });
  await plugins.load(builtInPlugins(config, options.channels ?? true, status));
  await plugins.load(options.plugins ?? []);
  if (config.plugins.directory) {
    await plugins.load(await loadPluginsFromDirectory(config.plugins.directory, log));
  }

  const onStop: (() => Promise<void>)[] = [];
  let repos = options.repos;
  let jobs: JobQueue | undefined = options.jobs;
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
    jobs ??= new PgBossJobQueue(config.database.url.reveal(), log);
    log.info('Using Postgres');
  }
  repos ??= inMemoryWithWarning(log);
  jobs ??= new InMemoryJobQueue(log, services.clock);
  await repos.owners.upsert({
    id: OWNER_ID,
    displayName: config.owner.name,
    timezone: config.owner.timezone,
    locale: config.owner.locale,
  });

  // The SOUL: seed revision 1 and refresh the readable export. A failure here must not stop startup:
  // the database copy still works, and turns re-read it.
  const soul = new SoulService({
    store: repos.soul,
    uow: repos.uow,
    ownerId: OWNER_ID,
    clock: services.clock,
    log,
    file: new NodeTextFile(path.join(config.paths.dataDir, 'SOUL.md')),
  });
  try {
    const revision = await soul.start();
    facts.soulRevision = revision.revision;
  } catch (error) {
    log.warn('Could not prepare the SOUL export', { error: serializeError(error) });
  }

  // Every provider gets the same chain: metering outside, retries inside, redaction closest to the wire.
  const catalog = catalogFrom(config);
  const providers = new Map(
    [...plugins.providers()].map(([id, raw]) => [
      id,
      new MeteredModelProvider(
        new RetryingModelProvider(new RedactingModelProvider(raw), {
          log,
          maxAttempts: config.models.retry.maxAttempts,
        }),
        { ownerId: OWNER_ID, usage: repos!.usage, catalog, clock: services.clock, log },
      ),
    ]),
  );
  const models = new ModelRouter(providers, config.models, catalog, log);
  const chat = selectChat(models);
  log.info('Using chat model', { model: chat.ref });
  const tools = new ToolCatalog(plugins.tools());
  tools.add(new ToolSearchTool(() => tools.list()));
  tools.add(new ToolCallGateway());
  const pipeline = new ToolPipeline(
    tools,
    defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
  );
  const agent = new Agent({
    name: 'Shitsuji',
    models,
    tools,
    pipeline,
    ownerId: OWNER_ID,
    repos,
    jobs,
    clock: services.clock,
    log,
    events,
    soul,
    stabilityCheck: process.env.NODE_ENV !== 'production',
  });
  Object.assign(facts, {
    storage: config.database.url && !options.repos ? 'postgres' : 'memory',
    chatModel: chat.ref,
    tools: tools.list().map((t) => t.name),
    workspaceDir: config.tools.workspaceDir,
  });
  for (const injectable of plugins.injectables()) agent.addInjectable(injectable);

  return new Shitsuji({
    agent,
    channels: plugins.channels(),
    plugins,
    log,
    events,
    version: VERSION,
    jobs,
    recovery: new StartupRecovery(repos, services.clock, log),
    startApi:
      (options.api ?? config.api.enabled)
        ? async () => {
            const keys = new OwnerKeyFile(config.paths.dataDir);
            const { created } = await keys.ensure();
            if (created) {
              // Shown once (decision Q3). Also saved to owner.key for the TUI on this machine.
              log.warn(`New owner key for the API: ${created}  (saved to ${keys.keyPath})`);
            }
            return startApiServer(
              {
                agent,
                repos: repos!,
                events,
                clock: services.clock,
                log,
                ownerId: OWNER_ID,
                soul,
                verifyKey: (k) => keys.verify(k),
              },
              config.api,
            );
          }
        : undefined,
    onStop,
  });
}

function builtInPlugins(
  config: ShitsujiConfig,
  withChannels: boolean,
  status: () => Promise<Record<string, unknown>>,
): ShitsujiPlugin[] {
  const endpoints = (kind: 'openai-compatible' | 'anthropic') =>
    Object.entries(config.models.providers)
      .filter(([, p]) => p.kind === kind)
      .map(([id, p]) => ({
        id,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        headers: p.headers,
        quirks: p.quirks,
      }));

  const list: ShitsujiPlugin[] = [
    new OpenAICompatiblePlugin(endpoints('openai-compatible')),
    new AnthropicPlugin(endpoints('anthropic')),
    new CoreToolsPlugin({
      workspaceDir: config.tools.workspaceDir!,
      exec: config.tools.exec,
      status,
    }),
    new WebToolsPlugin({
      searxngUrl: config.tools.web.searxngUrl,
      fetchEnabled: config.tools.web.fetch.enabled,
    }),
  ];
  if (withChannels && config.channels.webhook.enabled) {
    list.push(new WebhookChannelPlugin(config.channels.webhook));
  }
  return list;
}

/** models.catalog → ModelInfo, with prices as Money. */
function catalogFrom(config: ShitsujiConfig): ModelCatalog {
  return new ModelCatalog(
    Object.entries(config.models.catalog).map(([ref, m]) => ({
      ref,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      capabilities: m.capabilities && new Set(m.capabilities),
      price: m.price && {
        inputPerMTok: Money.of(m.price.inputPerMTok, m.price.currency),
        outputPerMTok: Money.of(m.price.outputPerMTok, m.price.currency),
        cachedInputPerMTok:
          m.price.cachedInputPerMTok === undefined
            ? undefined
            : Money.of(m.price.cachedInputPerMTok, m.price.currency),
      },
    })),
  );
}

/** The chat model must exist at startup; a missing one is a configuration problem, said plainly. */
function selectChat(models: ModelRouter) {
  try {
    return models.select('chat');
  } catch (error) {
    if (!(error instanceof NoModelAvailable)) throw error;
    throw new ConfigError(
      error.message.includes('not registered')
        ? `models.purposes.chat: ${error.message}`
        : 'No chat model configured. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) in .env, ' +
            'or add models.providers and models.purposes.chat to shitsuji.config.yaml.',
      {},
      { cause: error },
    );
  }
}
