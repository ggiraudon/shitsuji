import type {
  SandboxCapabilities,
  SandboxDriver,
  LeaseRequest,
  Sandbox,
} from '../../../ports/SandboxDriver.js';
import { HostEgress } from './HostEgress.js';
import { HostExec } from './HostExec.js';
import { WorkspaceRoot } from './WorkspaceRoot.js';

export interface HostSandboxOptions {
  /** The workspace folder the file and exec tools are confined to (decision Q1). */
  workspaceDir: string;
  /** Read-only roots the read tools may reach, e.g. the handoff folder (decision T2). */
  readDirs?: readonly string[];
  /** `tools.exec` from the config; when it is off the sandbox has no exec (decision Q1). */
  exec?: { enabled: boolean; maxTimeoutSeconds: number };
}

/**
 * Today's behaviour as a driver (F08, S40): the tools run on the host inside `core`. It claims no
 * isolation: `lanBlocked` is false, so nothing may assume the sandbox is cut off from the network
 * (S42 checks that claim).
 */
export class HostSandboxDriver implements SandboxDriver {
  readonly id = 'host';
  private readonly readDirs: readonly string[];

  constructor(private readonly options: HostSandboxOptions) {
    this.readDirs = options.readDirs ?? [];
  }

  async capabilities(): Promise<SandboxCapabilities> {
    return {
      files: { roots: [this.options.workspaceDir, ...this.readDirs] },
      ...(this.execEnabled && {
        exec: { maxTimeoutMs: this.options.exec!.maxTimeoutSeconds * 1000 },
      }),
      egress: { lanBlocked: false, credentialSwap: false },
    };
  }

  async open(_lease: LeaseRequest): Promise<Sandbox> {
    const files = new WorkspaceRoot(this.options.workspaceDir, this.readDirs);
    await files.root();
    return {
      files,
      ...(this.execEnabled && {
        exec: new HostExec({ maxTimeoutMs: this.options.exec!.maxTimeoutSeconds * 1000 }),
      }),
      egress: new HostEgress(),
      // Nothing to tear down yet: the host has no container. `sandboxd` closes its session here.
      close: async () => undefined,
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  private get execEnabled(): boolean {
    return this.options.exec?.enabled ?? false;
  }
}
