import path from 'node:path';
import { OwnerKeyFile } from '../adapters/auth/OwnerKeyFile.js';
import { InMemoryJobQueue } from '../adapters/jobs/InMemoryJobQueue.js';
import { PgBossJobQueue } from '../adapters/jobs/PgBossJobQueue.js';
import { InMemoryRepositories } from '../adapters/memory/InMemoryRepositories.js';
import { PostgresDatabase } from '../adapters/postgres/PostgresDatabase.js';
import { PostgresRepositories } from '../adapters/postgres/PostgresRepositories.js';
import { Agent } from '../application/Agent.js';
import { BudgetedModelProvider } from '../application/budget/BudgetedModelProvider.js';
import { BudgetService } from '../application/budget/BudgetService.js';
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
import { ChannelRegistry } from '../application/channels/ChannelRegistry.js';
import { PairingService } from '../application/channels/PairingService.js';
import { defaultMiddlewares } from '../application/tools/middlewares.js';
import { ToolCatalog } from '../application/tools/ToolCatalog.js';
import { ToolPipeline } from '../application/tools/ToolPipeline.js';
import { PolicyEngine } from '../application/trust/PolicyEngine.js';
import { ApprovalService } from '../application/trust/ApprovalService.js';
import { SessionAuthority, TrustService } from '../application/trust/TrustService.js';
import { TypedApprovalReader } from '../application/trust/TypedApprovalReader.js';
import { TrustJudge } from '../application/trust/TrustJudge.js';
import { ToolCallGateway } from '../application/tools/ToolCallGateway.js';
import { ToolSearchTool } from '../application/tools/ToolSearchTool.js';
import { StartupRecovery } from '../application/StartupRecovery.js';
import type { JobQueue } from '../ports/JobQueue.js';
import { ConfigError, serializeError } from '../domain/errors.js';
import { asId, type OwnerId } from '../domain/model/ids.js';
import { Money } from '../domain/model/Money.js';
import type { Repositories } from '../ports/Repositories.js';
import type { ShitsujiPlugin } from '../ports/Plugin.js';
import { WebhookChannelPlugin, TelegramChannelPlugin } from '../plugins/channelPlugins.js';
import { CoreToolsPlugin } from '../plugins/coreToolsPlugin.js';
import { TestToolsPlugin } from '../plugins/testToolsPlugin.js';
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

/** Decision Q1: the tools stay in `<dataDir>/workspace` unless the config names another folder. */
export function workspaceDirOf(config: ShitsujiConfig): string {
  return config.tools.workspaceDir ?? path.join(config.paths.dataDir, 'workspace');
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
  // The API and the webhook both check the owner key (decision Q3, #34). It is created at start().
  const keys = new OwnerKeyFile(config.paths.dataDir);
  const verifyKey = (key: string | undefined) => keys.verify(key);
  await plugins.load(builtInPlugins(config, options.channels ?? true, status, verifyKey));
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

  // Every provider gets the same chain: budget outside, metering next, retries inside, redaction
  // closest to the wire.
  const catalog = catalogFrom(config);
  const budget = new BudgetService({
    store: repos.budget,
    ownerId: OWNER_ID,
    clock: services.clock,
    log,
    limits: {
      monthly: Money.of(config.budget.monthlyLimit, config.budget.currency),
      background: Money.of(config.budget.backgroundAllowance, config.budget.currency),
    },
    checkIn: Money.of(config.budget.checkIn, config.budget.currency),
  });
  const providers = new Map(
    [...plugins.providers()].map(([id, raw]) => [
      id,
      new BudgetedModelProvider(
        new MeteredModelProvider(
          new RetryingModelProvider(new RedactingModelProvider(raw), {
            log,
            maxAttempts: config.models.retry.maxAttempts,
          }),
          { ownerId: OWNER_ID, usage: repos!.usage, catalog, clock: services.clock, log },
        ),
        { budget, catalog },
      ),
    ]),
  );
  const models = new ModelRouter(providers, config.models, catalog, log);
  const chat = selectChat(models);
  log.info('Using chat model', { model: chat.ref });
  // Cards are durable in the repository before they are shown; answering wakes the waiting turn (S36).
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events,
    clock: services.clock,
    log,
  });
  // The owner's words come from the session's transcript; the judge is a small model (M3).
  const trust = new TrustService({
    engine: new PolicyEngine(),
    authority: new SessionAuthority(repos.messages),
    judge: new TrustJudge({ models, log }),
    approvals,
    ownerId: OWNER_ID,
    log,
  });
  const typedApproval = new TypedApprovalReader({ models, log });
  const tools = new ToolCatalog(plugins.tools());
  tools.add(new ToolSearchTool(() => tools.list()));
  tools.add(new ToolCallGateway());
  const pipeline = new ToolPipeline(
    tools,
    defaultMiddlewares({
      turnEvents: repos.turnEvents,
      clock: services.clock,
      policy: trust,
      approvals,
    }),
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
    budget,
    stabilityCheck: config.context.stabilityCheck ?? true,
  });
  Object.assign(facts, {
    storage: config.database.url && !options.repos ? 'postgres' : 'memory',
    chatModel: chat.ref,
    tools: tools.list().map((t) => t.name),
    workspaceDir: workspaceDirOf(config),
  });
  for (const injectable of plugins.injectables()) agent.addInjectable(injectable);

  const channels = new ChannelRegistry();
  for (const channel of plugins.channels()) channels.add(channel);
  const pairing = new PairingService(services.clock);
  const startsApi = options.api ?? config.api.enabled;

  return new Shitsuji({
    agent,
    channels,
    plugins,
    log,
    events,
    version: VERSION,
    jobs,
    recovery: new StartupRecovery(repos, services.clock, log),
    bindings: repos.bindings,
    pairing,
    repos,
    ownerId: OWNER_ID,
    clock: services.clock,
    approvals,
    readTypedApproval: (text, approval) => typedApproval.read(text, approval),
    prepare:
      startsApi || channels.size > 0
        ? async () => {
            const { created } = await keys.ensure();
            if (created) {
              // Shown once (decision Q3). Also saved to owner.key for the TUI on this machine.
              log.warn(`New owner key: ${created}  (saved to ${keys.keyPath})`);
            }
          }
        : undefined,
    startApi: startsApi
      ? () =>
          startApiServer(
            {
              agent,
              repos: repos!,
              events,
              clock: services.clock,
              log,
              ownerId: OWNER_ID,
              soul,
              pairing,
              approvals,
              verifyKey,
            },
            config.api,
          )
      : undefined,
    onStop,
  });
}

function builtInPlugins(
  config: ShitsujiConfig,
  withChannels: boolean,
  status: () => Promise<Record<string, unknown>>,
  verifyKey: (key: string | undefined) => boolean,
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
      workspaceDir: workspaceDirOf(config),
      handoffDir: path.join(config.paths.dataDir, 'handoff'),
      exec: config.tools.exec,
      status,
    }),
    new WebToolsPlugin({
      searxngUrl: config.tools.web.searxngUrl,
      fetchEnabled: config.tools.web.fetch.enabled,
    }),
    ...(config.tools.notifyUrl ? [new TestToolsPlugin({ notifyUrl: config.tools.notifyUrl })] : []),
  ];
  if (withChannels && config.channels.webhook.enabled) {
    list.push(new WebhookChannelPlugin({ ...config.channels.webhook, authorize: verifyKey }));
  }
  if (withChannels && config.channels.telegram.enabled) {
    const token = config.channels.telegram.token;
    if (!token) {
      throw new ConfigError(
        'channels.telegram.enabled is true but channels.telegram.token is not set ' +
          '(put SHITSUJI_TELEGRAM_TOKEN in .env).',
      );
    }
    list.push(
      new TelegramChannelPlugin({
        token: token.reveal(),
        handoffDir: path.join(config.paths.dataDir, 'handoff'),
      }),
    );
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
