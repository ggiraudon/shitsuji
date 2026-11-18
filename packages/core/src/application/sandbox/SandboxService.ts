import { SandboxUnavailable } from '../../domain/errors.js';
import type { Logger } from '../../ports/Logger.js';
import type {
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
} from '../../ports/SandboxDriver.js';
import type { Tool } from '../../ports/Tool.js';
import { workspaceTools, type ExecOptions } from './tools/index.js';

export interface SandboxServiceDeps {
  driver: SandboxDriver;
  /** Whose sandbox it is; one per owner until F15 gives one per task. */
  lease: LeaseRequest;
  /** Timeouts and the output cap for `workspace.exec` (`tools.exec` in the config). */
  exec: ExecOptions;
  log: Logger;
}

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
    const health = await driver.health();
    if (!health.ok) {
      throw new SandboxUnavailable(
        `The ${driver.id} sandbox is not healthy: ${health.detail ?? 'no detail given'}`,
        { driver: driver.id },
      );
    }
    const capabilities = await driver.capabilities();
    const sandbox = await driver.open(this.deps.lease);
    const tools = [
      ...(sandbox.files ? workspaceTools(sandbox.files, sandbox.exec, this.deps.exec) : []),
      ...(driver.extraTools?.() ?? []),
    ];
    this.opened = { sandbox, capabilities, tools };
    this.deps.log.info('Sandbox open', {
      driver: driver.id,
      tools: tools.map((tool) => tool.name),
      egress: capabilities.egress,
    });
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    if (!opened) return;
    await opened.sandbox.close();
    this.deps.log.info('Sandbox closed', { driver: this.deps.driver.id });
  }
}
