import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryRepositories } from '../packages/core/src/adapters/memory/InMemoryRepositories.js';
import { HostSandboxDriver } from '../packages/core/src/adapters/sandbox/host/HostSandboxDriver.js';
import {
  createShitsuji,
  OWNER_ID,
  workspaceDirOf,
} from '../packages/core/src/composition/createShitsuji.js';
import { loadConfig } from '../packages/core/src/composition/config/loadConfig.js';
import {
  shitsujiConfigSchema,
  type ShitsujiConfig,
} from '../packages/core/src/composition/config/schema.js';
import { asId, type ApprovalId } from '../packages/core/src/domain/model/ids.js';
import { contextBudget, globalChecks, unsafeActions } from './checks.js';
import { EvalDesktopDriver } from './desktopDriver.js';
import { MockServices } from './fakes.js';
import { OfflineProvider } from './offlineProvider.js';
import { EvalModelPlugin, EvalToolsPlugin } from './plugins.js';
import type {
  ApprovalRecord,
  Check,
  EvalReport,
  Receipt,
  Scenario,
  ScenarioContext,
  ScenarioRun,
} from './types.js';

export interface RunOptions {
  /** A model ref for a live run, or `eval/offline` offline. */
  model: string;
  offline: boolean;
  /** Give up on one scenario after this long (default 180 s). */
  timeoutMs?: number;
}

/** Runs one scenario in a fresh graph and a fresh temp data folder (S38). */
export async function runScenario(scenario: Scenario, options: RunOptions): Promise<ScenarioRun> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shitsuji-eval-'));
  const world = new MockServices();
  const provider = options.offline
    ? new OfflineProvider({
        steps: scenario.steps,
        judge: scenario.judge ?? 'allow',
        ownerWords: scenario.message,
      })
    : undefined;
  const repos = new InMemoryRepositories();
  let shitsuji: Awaited<ReturnType<typeof createShitsuji>> | undefined;
  let error: string | undefined;
  let reply = '';
  const approvals: ApprovalRecord[] = [];
  let receipts: Receipt[] = [];

  try {
    const config = options.offline
      ? offlineConfig(dataDir, scenario.exec ?? false, scenario.vision ?? false)
      : liveConfig(dataDir, options.model, scenario.exec ?? false);
    const sandboxDriver =
      options.offline && scenario.desktop
        ? new EvalDesktopDriver(
            new HostSandboxDriver({
              workspaceDir: workspaceDirOf(config),
              readDirs: [path.join(dataDir, 'handoff')],
              exec: {
                enabled: scenario.exec ?? false,
                maxTimeoutSeconds: config.tools.exec.maxTimeoutSeconds,
              },
            }),
            scenario.desktop(path.join(dataDir, 'workspace')),
          )
        : undefined;
    shitsuji = await createShitsuji(config, {
      plugins: [new EvalToolsPlugin(world), ...(provider ? [new EvalModelPlugin(provider)] : [])],
      repos,
      channels: false,
      api: false,
      ...(sandboxDriver && { sandboxDriver }),
    });
    await shitsuji.start();

    const off = shitsuji.events.subscribe('approval.requested', (event) => {
      const record: ApprovalRecord = {
        id: event.approvalId,
        tool: event.tool,
        summary: event.summary,
        status: 'pending',
      };
      approvals.push(record);
      void shitsuji?.approvals
        ?.resolve(asId<ApprovalId>(event.approvalId), scenario.approvals ?? 'approve')
        .then((approval) => {
          record.status = approval.status;
        });
    });

    try {
      const started = new Date();
      const result = await withTimeout(
        shitsuji.agent.send(scenario.message),
        options.timeoutMs ?? 180_000,
        scenario.id,
      );
      reply = result.reply;
      receipts = (await repos.turnEvents.listByTurn(result.turnId))
        .filter((event) => event.kind === 'tool_end')
        .map((event) => event.data as unknown as Receipt);
      const usage = (await repos.usage.listSince(OWNER_ID, started)).filter(
        (row) => row.turnId === result.turnId,
      );
      const context = provider ? budgetOf(provider) : undefined;
      const imagesSent = provider ? imagesSentBy(provider) : undefined;
      const scenarioContext: ScenarioContext = {
        workspaceDir: path.join(dataDir, 'workspace'),
        mailbox: world.mailbox,
        receipts,
        approvals,
        reply,
        ...(imagesSent !== undefined && { imagesSent }),
        ...(context && { context }),
      };
      const ownChecks = await scenario.check(scenarioContext);
      const checks: Check[] = [
        ...ownChecks,
        ...globalChecks(receipts, scenario.forbiddenTools ?? [], context),
      ];
      const cost = sumCost(usage.map((row) => row.cost));
      return {
        id: scenario.id,
        title: scenario.title,
        passed: checks.every((check) => check.passed),
        checks,
        steps: usage.length,
        inputTokens: usage.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: usage.reduce((sum, row) => sum + row.outputTokens, 0),
        ...cost,
        unsafe: unsafeActions(receipts, scenario.forbiddenTools ?? []),
        ...(context && { context }),
      };
    } finally {
      off();
    }
  } catch (caught) {
    error = (caught as Error)?.message ?? String(caught);
    return {
      id: scenario.id,
      title: scenario.title,
      passed: false,
      checks: [],
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      unsafe: unsafeActions(receipts, scenario.forbiddenTools ?? []),
      error,
    };
  } finally {
    await shitsuji?.stop().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs every scenario (or the ones given) and sums the report. */
export async function runEvals(
  options: RunOptions,
  scenarios: readonly Scenario[],
): Promise<EvalReport> {
  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) runs.push(await runScenario(scenario, options));
  const totals = runs.reduce(
    (sum, run) => ({
      steps: sum.steps + run.steps,
      inputTokens: sum.inputTokens + run.inputTokens,
      outputTokens: sum.outputTokens + run.outputTokens,
      ...(run.costMicros !== undefined && {
        costMicros: (sum.costMicros ?? 0) + run.costMicros,
      }),
      ...(run.currency && { currency: run.currency }),
      unsafe: sum.unsafe + run.unsafe.length,
    }),
    { steps: 0, inputTokens: 0, outputTokens: 0, unsafe: 0 } as EvalReport['totals'],
  );
  return {
    model: options.model,
    scenarios: runs,
    passRate: runs.length ? runs.filter((run) => run.passed).length / runs.length : 0,
    totals,
  };
}

/** A readable report: one line per scenario, then totals. */
export function formatReport(report: EvalReport): string {
  const lines = [
    `Evaluation: ${report.model}`,
    '',
    'Scenario                         Result  Steps  Tokens (in/out)  Cost        Unsafe',
    '-------------------------------  ------  -----  ---------------  ----------  ------',
  ];
  for (const run of report.scenarios) {
    const cost =
      run.costMicros === undefined
        ? 'unknown'
        : `${(run.costMicros / 1_000_000).toFixed(4)} ${run.currency ?? ''}`;
    lines.push(
      `${run.id.padEnd(31).slice(0, 31)}  ${(run.passed ? 'pass' : 'FAIL').padEnd(6)}  ${String(
        run.steps,
      ).padStart(5)}  ${`${run.inputTokens}/${run.outputTokens}`.padStart(15)}  ${cost.padEnd(
        10,
      )}  ${String(run.unsafe.length).padStart(6)}`,
    );
    for (const check of run.checks.filter((c) => !c.passed)) {
      lines.push(`    failed: ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    if (run.error) lines.push(`    error: ${run.error}`);
    if (run.context) {
      lines.push(
        `    context: ${run.context.totalTokens} tokens (${run.context.systemTokens} system, ${run.context.toolTokens} tools; budget ${run.context.budgetTokens})`,
      );
    }
  }
  const cost =
    report.totals.costMicros === undefined
      ? 'unknown'
      : `${(report.totals.costMicros / 1_000_000).toFixed(4)} ${report.totals.currency ?? ''}`;
  lines.push('');
  lines.push(
    `Pass rate: ${(report.passRate * 100).toFixed(0)}%  Steps: ${report.totals.steps}  Tokens: ${report.totals.inputTokens}/${report.totals.outputTokens}  Cost: ${cost}  Unsafe: ${report.totals.unsafe}`,
  );
  return lines.join('\n');
}

function offlineConfig(dataDir: string, exec: boolean, vision: boolean): ShitsujiConfig {
  return shitsujiConfigSchema.parse({
    paths: { dataDir },
    sandbox: { probes: { enabled: false } },
    channels: { webhook: { enabled: false }, telegram: { enabled: false } },
    api: { enabled: false },
    tools: { exec: { enabled: exec }, web: { fetch: { enabled: false } } },
    models: {
      providers: { eval: { kind: 'plugin' } },
      purposes: {
        chat: 'eval/offline',
        trust: 'eval/offline',
        ...(vision && { vision: 'eval/offline' }),
      },
      ...(vision && {
        catalog: { 'eval/offline': { capabilities: ['tools', 'vision'] } },
      }),
    },
    logging: { level: 'error' },
  });
}

function liveConfig(dataDir: string, model: string, exec: boolean): ShitsujiConfig {
  // Read providers from the environment, with no config file from this repo in the way.
  const { config } = loadConfig({ cwd: dataDir });
  config.paths.dataDir = dataDir;
  config.channels.webhook.enabled = false;
  config.channels.telegram.enabled = false;
  config.api.enabled = false;
  config.tools.exec.enabled = exec;
  config.sandbox.probes.enabled = false;
  config.tools.web.fetch.enabled = false;
  config.models.purposes.chat = model;
  config.models.purposes.trust = model;
  config.logging.level = 'error';
  return config;
}

/** How many images reached any model request; zero is the structure-only invariant. */
function imagesSentBy(provider: OfflineProvider): number {
  let images = 0;
  for (const request of provider.requests) {
    for (const message of request.messages) {
      for (const part of message.parts) {
        if (part.type === 'image') images += 1;
        else if (part.type === 'tool_result') images += part.images?.length ?? 0;
      }
    }
  }
  return images;
}

function budgetOf(provider: OfflineProvider) {
  const request = provider.requests.find((r) => r.metadata?.purpose !== 'trust');
  if (!request) return undefined;
  return contextBudget(request.system, request.tools);
}

function sumCost(costs: readonly ({ micros: number; currency: string } | undefined)[]) {
  const known = costs.filter((cost): cost is { micros: number; currency: string } => !!cost);
  if (!known.length) return {};
  const currency = known[0]!.currency;
  return {
    costMicros: known.filter((c) => c.currency === currency).reduce((sum, c) => sum + c.micros, 0),
    currency,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Scenario ${id} timed out after ${ms} ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
