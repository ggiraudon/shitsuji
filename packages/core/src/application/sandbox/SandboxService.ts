import { SandboxUnavailable } from '../../domain/errors.js';
import type { Logger } from '../../ports/Logger.js';
import type { OutboundFiles } from '../../ports/OutboundFiles.js';
import type {
  DriverHealth,
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
  ViewerCredentials,
} from '../../ports/SandboxDriver.js';
import type { Tool } from '../../ports/Tool.js';
import type { EgressProbe } from './EgressProbe.js';
import { workspaceTools, type ExecOptions } from './tools/index.js';

export interface SandboxServiceDeps {
  driver: SandboxDriver;
  /** Whose sandbox it is; one per owner until F15 gives one per task. */
  lease: LeaseRequest;
  /** Timeouts and the output cap for `workspace.exec` (`tools.exec` in the config). */
  exec: ExecOptions;
  /** Where a file leaving the sandbox is staged for the channel (S41). */
  outbound: OutboundFiles;
  /** Checks the driver's egress claim at startup and on health() (S42). */
  egress: EgressProbe;
  log: Logger;
  /**
   * How long a cold start waits for the driver's health check (S49). Compose starts core after the
   * gateway, but a daemon can still be a second behind; source runs keep the one-attempt default
   * in tests.
   */
  retry?: { attempts: number; delayMs: number };
}

const DEFAULT_RETRY = { attempts: 10, delayMs: 2_000 };

/**
 * The one sandbox `core` talks to (F08, S40). It opens the driver's sandbox at startup, builds the
 * standard tools for the capabilities the driver reports, and closes it on shutdown. A driver that
 * fails its health check is refused with `SandboxUnavailable`: there is no fallback to another
 * driver (decision X3).
 */
export class SandboxService {
  private opened?: {
    sandbox: Sandbox;
    capabilities: SandboxCapabilities;
    tools: readonly Tool[];
  };

  constructor(private readonly deps: SandboxServiceDeps) {}

  get driverId(): string {
    return this.deps.driver.id;
  }

  /** The capabilities the open sandbox reported; undefined before start(). */
  get capabilities(): SandboxCapabilities | undefined {
    return this.opened?.capabilities;
  }

  /** The standard tools this sandbox supports; empty before start(). */
  tools(): readonly Tool[] {
    return this.opened?.tools ?? [];
  }

  async start(): Promise<void> {
    if (this.opened) return;
    const driver = this.deps.driver;
    const health = await this.waitForHealth();
    if (!health.ok) {
      throw new SandboxUnavailable(
        `The ${driver.id} sandbox is not healthy: ${health.detail ?? 'no detail given'}`,
        { driver: driver.id },
      );
    }
    const capabilities = await driver.capabilities();
    const sandbox = await driver.open(this.deps.lease);
    if (sandbox.files) {
      // The layout from F08: work any session may read, and forged tools (F20). Session folders are
      // made when a tool first writes in one.
      for (const folder of ['shared', 'tools']) {
        await sandbox.files.mkdir(await sandbox.files.resolve(folder));
      }
    }
    // A contradicted egress claim refuses the sandbox before any tool exists (S42).
    const report = await this.deps.egress.check(sandbox, capabilities, driver.id);
    const tools = [
      ...(sandbox.files
        ? workspaceTools(sandbox.files, sandbox.exec, this.deps.exec, this.deps.outbound)
        : []),
      ...this.extraToolsOf(driver),
    ];
    this.opened = { sandbox, capabilities, tools };
    this.deps.log.info('Sandbox open', {
      driver: driver.id,
      tools: tools.map((tool) => tool.name),
      egress: capabilities.egress,
      reachable: report.reachable.map((target) => `${target.host}:${target.port}`),
    });
  }

  /**
   * A bounded wait for the driver's health check (S49): Compose orders the services, but sandboxd
   * can still be starting when core is, and a restart is worse than a few seconds in the log. The
   * last answer is returned to the caller, which turns it into `SandboxUnavailable`.
   */
  private async waitForHealth(): Promise<DriverHealth> {
    const retry = this.deps.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const health = await this.deps.driver.health();
      if (health.ok || attempt >= retry.attempts) return health;
      this.deps.log.warn('Sandbox not ready; retrying', {
        driver: this.deps.driver.id,
        attempt,
        attempts: retry.attempts,
        delayMs: retry.delayMs,
        detail: health.detail ?? 'no detail given',
      });
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    }
  }

  /**
   * Where an attachment from the owner lives, as the active driver names it (#100). The note the
   * model receives must use the sandbox's absolute path, not core's host path: a shitsuji attachment
   * under `<dataDir>/handoff` becomes `/handoff/photo.jpg`, which works both in the file tools and
   * in a shell command whose cwd is `/workspace`. The host driver keeps its absolute path. A
   * missing sandbox or an unresolvable file falls back to the bare name.
   */
  async attachmentPath(hostPath: string): Promise<string> {
    const files = this.opened?.sandbox.files;
    if (!files) return hostPath;
    const name = hostPath.split(/[\\/]/).pop() ?? hostPath;
    try {
      return await files.resolveRead(name);
    } catch {
      return name;
    }
  }

  /** The view-only VNC password for the owner's viewer (S51); no desktop is an error, not a blank. */
  async viewerCredentials(): Promise<ViewerCredentials> {
    const driver = this.deps.driver;
    if (!driver.viewerCredentials) {
      throw new SandboxUnavailable(`The ${driver.id} sandbox has no desktop viewer.`, {
        driver: driver.id,
      });
    }
    return driver.viewerCredentials();
  }

  /** Driver health, then the egress claim again (S42); a broken claim throws `SandboxUnavailable`. */
  async health(): Promise<DriverHealth> {
    const health = await this.deps.driver.health();
    if (!health.ok || !this.opened) return health;
    await this.deps.egress.check(
      this.opened.sandbox,
      this.opened.capabilities,
      this.deps.driver.id,
    );
    return { ok: true };
  }

  /**
   * A driver's own tools must be named `<id>.*`, so they cannot shadow a standard tool (`workspace.*`,
   * `tool_search`, …) or another driver's, and each name appears once (F08, S42).
   */
  private extraToolsOf(driver: SandboxDriver): readonly Tool[] {
    const extras = driver.extraTools?.() ?? [];
    const seen = new Set<string>();
    for (const tool of extras) {
      if (!tool.name.startsWith(`${driver.id}.`)) {
        throw new SandboxUnavailable(
          `The ${driver.id} sandbox offered the tool "${tool.name}"; a driver's own tools must be ` +
            `named "${driver.id}.*", so they cannot shadow a standard tool.`,
          { driver: driver.id, tool: tool.name },
        );
      }
      if (seen.has(tool.name)) {
        throw new SandboxUnavailable(`The ${driver.id} sandbox offered "${tool.name}" twice.`, {
          driver: driver.id,
          tool: tool.name,
        });
      }
      seen.add(tool.name);
    }
    return extras;
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    if (!opened) return;
    await opened.sandbox.close();
    this.deps.log.info('Sandbox closed', { driver: this.deps.driver.id });
  }
}
