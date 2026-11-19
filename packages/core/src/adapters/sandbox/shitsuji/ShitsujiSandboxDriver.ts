import { SANDBOX_ROUTES, capabilitiesReplySchema } from '@shitsuji/sandbox-protocol';
import type { Logger } from '../../../ports/Logger.js';
import type {
  DriverHealth,
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
} from '../../../ports/SandboxDriver.js';
import { SandboxClient } from './ShitsujiSandbox.js';
import { ShitsujiEgress, ShitsujiExec, ShitsujiFiles } from './ShitsujiSandbox.js';

export interface ShitsujiDriverOptions {
  /** The sandboxd service, e.g. http://sandbox:4555. */
  baseUrl: string;
  /** The generated token, from `<dataDir>/sandbox.token`; never logged. */
  token: string;
  log: Logger;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/**
 * F08's own sandbox driver (S48): `sandboxd` in the `sandbox` container, reached over the internal
 * network. It claims the LAN is blocked because the sandbox has no route out except egress-proxy,
 * and no credential swapping (that is F12's proxy, later).
 */
export class ShitsujiSandboxDriver implements SandboxDriver {
  readonly id = 'shitsuji';
  private readonly client: SandboxClient;

  constructor(private readonly options: ShitsujiDriverOptions) {
    this.client = new SandboxClient({
      baseUrl: options.baseUrl,
      token: options.token,
      ...(options.fetch && { fetch: options.fetch }),
    });
  }

  async capabilities(): Promise<SandboxCapabilities> {
    const reply = await this.client.call(SANDBOX_ROUTES.capabilities, capabilitiesReplySchema);
    return {
      files: { roots: reply.files.roots.map((root) => `/${root}`) },
      exec: { maxTimeoutMs: reply.exec.maxTimeoutMs },
      egress: { lanBlocked: true, credentialSwap: false },
    };
  }

  async open(_lease: LeaseRequest): Promise<Sandbox> {
    const capabilities = await this.capabilities();
    return {
      files: new ShitsujiFiles(this.client),
      exec: new ShitsujiExec(this.client, capabilities.exec!.maxTimeoutMs),
      egress: new ShitsujiEgress(this.client),
      close: async () => undefined,
    };
  }

  async health(): Promise<DriverHealth> {
    return this.client.health();
  }
}
