import { SandboxUnavailable } from '../../domain/errors.js';
import type { SessionId, TurnId } from '../../domain/model/ids.js';
import type {
  DesktopControlMode,
  DesktopControlStatus,
  TakeControlPort,
} from '../../ports/DesktopControl.js';
import type { Logger } from '../../ports/Logger.js';
import type { OutboundFiles } from '../../ports/OutboundFiles.js';
import type {
  DesktopA11yStatus,
  DriverHealth,
  FullViewerCredentials,
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
  ViewerCredentials,
} from '../../ports/SandboxDriver.js';
import type { Tool, ToolImage } from '../../ports/Tool.js';
import type { EgressProbe } from './EgressProbe.js';
import { workspaceTools, type ExecOptions } from './tools/index.js';
import { computerActTools } from '../desktop/ComputerActTool.js';
import { desktopA11yTools } from '../desktop/DesktopA11yTools.js';
import { takeControlTools } from '../desktop/TakeControlTool.js';

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
  /** Whether the vision purpose's model can see images; gates computer.act (S53). */
  vision?: boolean;
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
  /** `owner` while the owner has the desktop; starts as `agent` in every process (S55). */
  private ownerControl = false;
  private controlInfo?: { requestedBy: 'agent' | 'owner'; reason?: string; since: Date };
  private readonly controlListeners = new Set<(mode: DesktopControlMode) => void>();
  private takeControl?: TakeControlPort;

  constructor(private readonly deps: SandboxServiceDeps) {}

  /** The takeover service, set by composition before start so the tool can be registered. */
  setTakeControl(control: TakeControlPort): void {
    this.takeControl = control;
  }

  /** Who may write to the desktop now; reads are still allowed in owner mode. */
  get desktopMode(): DesktopControlMode {
    return this.ownerControl ? 'owner' : 'agent';
  }

  /** The mode plus who asked and why; no expiry or viewer URL (the control service adds those). */
  get desktopControlStatus(): DesktopControlStatus {
    return {
      mode: this.desktopMode,
      ...(this.controlInfo?.requestedBy && { requestedBy: this.controlInfo.requestedBy }),
      ...(this.controlInfo?.reason && { reason: this.controlInfo.reason }),
      ...(this.controlInfo?.since && { since: this.controlInfo.since.toISOString() }),
    };
  }

  /** Enters owner mode; the control service calls this only for a real desktop (S55). */
  enterOwnerControl(input: { requestedBy: 'agent' | 'owner'; reason?: string; since: Date }): void {
    if (!this.opened?.sandbox.desktop) {
      throw new SandboxUnavailable('This sandbox has no desktop to take control of.');
    }
    const changed = !this.ownerControl;
    this.ownerControl = true;
    this.controlInfo = {
      requestedBy: input.requestedBy,
      ...(input.reason && { reason: input.reason }),
      since: input.since,
    };
    if (changed) this.notifyControl();
  }

  /** Returns to agent mode; idempotent, and notifies the viewer so full streams close. */
  leaveOwnerControl(): void {
    if (!this.ownerControl) return;
    this.ownerControl = false;
    this.controlInfo = undefined;
    this.notifyControl();
  }

  /** Subscribes to mode changes (the viewer closes every full-control stream on `agent`). */
  onDesktopModeChange(listener: (mode: DesktopControlMode) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  private notifyControl(): void {
    const mode = this.desktopMode;
    for (const listener of this.controlListeners) {
      try {
        listener(mode);
      } catch {
        // A viewer listener that throws must not break the mode change.
      }
    }
  }

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
      ...(sandbox.desktop && sandbox.desktop.accessibility
        ? desktopA11yTools(sandbox.desktop, () => this.ownerControl)
        : []),
      ...(sandbox.desktop && this.takeControl ? takeControlTools(this.takeControl) : []),
      ...(sandbox.files && sandbox.desktop && this.deps.vision
        ? computerActTools(sandbox.files, sandbox.desktop, () => this.ownerControl)
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

  /** The full-control VNC password (S55); only in owner mode, so a bug cannot hand it out early. */
  async fullViewerCredentials(): Promise<FullViewerCredentials> {
    if (this.desktopMode !== 'owner') {
      throw new SandboxUnavailable('The owner does not have control of the desktop.');
    }
    const driver = this.deps.driver;
    if (!driver.fullViewerCredentials) {
      throw new SandboxUnavailable(`The ${driver.id} sandbox has no full-control viewer.`, {
        driver: driver.id,
      });
    }
    return driver.fullViewerCredentials();
  }

  /**
   * A fresh screenshot for the note a resumed turn sees (S55), saved under the session's images.
   * Returns undefined when the sandbox has no desktop or the capture fails; the note still says the
   * screen may have changed.
   */
  async captureScreenshot(sessionId: SessionId, turnId: TurnId): Promise<ToolImage | undefined> {
    const desktop = this.opened?.sandbox.desktop;
    const files = this.opened?.sandbox.files;
    if (!desktop || !files) return undefined;
    try {
      const shot = await desktop.screenshot();
      const name = `take-control-${turnId}.png`;
      const ref = `sessions/${sessionId}/images/${name}`;
      await files.writeBytes(await files.resolve(ref), shot.data);
      return { mediaType: 'image/png', ref, name };
    } catch (error) {
      this.deps.log.warn('Could not capture the desktop after control', {
        sessionId,
        error: { message: error instanceof Error ? error.message : 'unknown' },
      });
      return undefined;
    }
  }

  /** Which allowed apps publish a tree (S54); undefined when the sandbox has no accessibility. */
  async accessibilityStatus(): Promise<DesktopA11yStatus | undefined> {
    const desktop = this.opened?.sandbox.desktop;
    if (!desktop?.accessibility) return undefined;
    return desktop.accessibilityStatus();
  }

  /**
   * Reads a workspace-relative image reference for the context builder (S52). The bytes go through
   * the same driver files port as every other workspace read; core never touches the folder itself.
   */
  async readBytes(path: string): Promise<Uint8Array> {
    const files = this.opened?.sandbox.files;
    if (!files) throw new SandboxUnavailable('The sandbox is not open.');
    return files.readBytes(await files.resolveRead(path));
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
