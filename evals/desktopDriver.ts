import type { HostSandboxDriver } from '../packages/core/src/adapters/sandbox/host/HostSandboxDriver.js';
import type {
  DesktopCapability,
  DriverHealth,
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
} from '../packages/core/src/ports/SandboxDriver.js';

/**
 * The host driver with a fake desktop for an offline eval (S56). The real desktop tools register
 * exactly as they would for `shitsuji`; only the display is simulated, so no Docker or app is needed.
 */
export class EvalDesktopDriver implements SandboxDriver {
  readonly id = 'host';

  constructor(
    private readonly host: HostSandboxDriver,
    private readonly desktop: DesktopCapability,
  ) {}

  async capabilities(): Promise<SandboxCapabilities> {
    return {
      ...(await this.host.capabilities()),
      desktop: { accessibility: true, screenshots: true, takeControl: false },
    };
  }

  async open(lease: LeaseRequest): Promise<Sandbox> {
    return { ...(await this.host.open(lease)), desktop: this.desktop };
  }

  async health(): Promise<DriverHealth> {
    return this.host.health();
  }
}
