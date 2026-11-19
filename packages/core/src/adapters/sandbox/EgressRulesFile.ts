import fs from 'node:fs';
import path from 'node:path';

export interface EgressRules {
  /** Empty means the open default: any public host may leave. */
  allow: readonly string[];
  /** Refused in both modes. */
  deny: readonly string[];
}

/**
 * Writes `sandbox.egress.allow/deny` where egress-proxy reads them (F08, S48). The proxy follows the
 * file, so the owner edits one config file instead of the proxy's environment in `.env`.
 */
export class EgressRulesFile {
  constructor(readonly file: string) {}

  write(rules: EgressRules): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // `ready` tells egress-proxy these are core's rules, not the closed seed of a fresh volume.
    const body = JSON.stringify({ allow: rules.allow, deny: rules.deny, ready: true }, null, 2);
    fs.writeFileSync(this.file, `${body}\n`, { mode: 0o644 });
  }
}
