import { SandboxUnavailable } from '../../domain/errors.js';
import type { Logger } from '../../ports/Logger.js';
import type { Sandbox, SandboxCapabilities } from '../../ports/SandboxDriver.js';

export interface EgressTarget {
  /** How the error and the log name it: "LAN", "core's API", "postgres". */
  label: string;
  host: string;
  port: number;
}

export interface EgressProbeDeps {
  targets: readonly EgressTarget[];
  /** Refuse a driver without `lanBlocked` that can reach something (`sandbox.probes.requireIsolation`). */
  requireIsolation?: boolean;
  timeoutMs?: number;
  log: Logger;
}

export interface EgressReport {
  /** What the driver claimed. */
  lanBlocked: boolean;
  /** The addresses the sandbox actually reached. */
  reachable: EgressTarget[];
}

/**
 * Checks the driver's egress claim instead of trusting it (F08, S42): a sandbox that says it blocks
 * the LAN must not reach the configured addresses, `core`'s API or Postgres. A claim that is
 * contradicted refuses the driver (`SandboxUnavailable`, naming the address), so the sandbox tools
 * stay off; there is no fallback to another driver (X3).
 *
 * A driver that makes no claim (the host driver) is allowed to have network, but `requireIsolation`
 * turns that into a refusal too, and either way the log says the isolation is not there.
 */
export class EgressProbe {
  constructor(private readonly deps: EgressProbeDeps) {}

  async check(
    sandbox: Sandbox,
    capabilities: SandboxCapabilities,
    driverId: string,
  ): Promise<EgressReport> {
    const lanBlocked = capabilities.egress.lanBlocked;
    if (lanBlocked && !sandbox.egress) {
      throw new SandboxUnavailable(
        `The ${driverId} sandbox claims lanBlocked but cannot run an egress probe, so the claim ` +
          'cannot be checked.',
        { driver: driverId },
      );
    }
    const reachable: EgressTarget[] = [];
    if (sandbox.egress) {
      for (const target of this.deps.targets) {
        if (await sandbox.egress.reachable(target.host, target.port, this.timeoutMs)) {
          reachable.push(target);
        }
      }
    }
    if (lanBlocked && reachable.length) {
      throw new SandboxUnavailable(
        `The ${driverId} sandbox claims lanBlocked but reached ${describeTarget(reachable[0]!)}; ` +
          'refusing it, so its tools stay off.',
        { driver: driverId, address: addressOf(reachable[0]!) },
      );
    }
    if (!lanBlocked && reachable.length) {
      if (this.deps.requireIsolation) {
        throw new SandboxUnavailable(
          `The ${driverId} sandbox has no egress control and reached ${describeTarget(reachable[0]!)}; ` +
            'sandbox.probes.requireIsolation is on, so it is refused.',
          { driver: driverId, address: addressOf(reachable[0]!) },
        );
      }
      this.deps.log.warn('The sandbox has network access and makes no isolation claim', {
        driver: driverId,
        reached: reachable.map((target) => describeTarget(target)),
      });
    }
    return { lanBlocked, reachable };
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? 1_000;
  }
}

const addressOf = (target: EgressTarget) => `${target.host}:${target.port}`;
const describeTarget = (target: EgressTarget) => `${target.label} (${addressOf(target)})`;
