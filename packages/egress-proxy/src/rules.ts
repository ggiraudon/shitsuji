import {
  ALWAYS_BLOCKED,
  blockedReason,
  formatIp,
  normalizeAddress,
  parseCidr,
  parseIp,
  rangeContains,
  rangesOverlap,
  type CidrRange,
  type IpAddress,
} from './address.js';

/** One entry of the allow or deny list: a domain (optionally `*.`) or a CIDR range. */
export type RuleEntry =
  | { kind: 'domain'; host: string; wildcard: boolean; source: string }
  | { kind: 'cidr'; range: CidrRange; source: string };

export interface PolicyConfig {
  /** Empty or absent means the open default: any public host may leave. */
  allow?: readonly string[];
  /** Refused in both modes. */
  deny?: readonly string[];
}

export type Decision =
  | { allowed: true; address: IpAddress; addresses: readonly IpAddress[] }
  | { allowed: false; reason: string; address?: IpAddress };

export interface EgressPolicy {
  readonly allow: readonly RuleEntry[];
  readonly deny: readonly RuleEntry[];
  decide(host: string, addresses: readonly IpAddress[]): Decision;
}

/**
 * The rules from X7: open internet by default; private, loopback, link-local, CGNAT, multicast,
 * unspecified and cloud-metadata addresses are always refused, whatever the allow list says; the
 * optional allow list narrows the open internet, and deny narrows both. Decisions use the resolved
 * addresses, never the name alone.
 */
export function createPolicy(config: PolicyConfig = {}): EgressPolicy {
  const allow = (config.allow ?? []).flatMap((entry) => parseEntry(entry));
  const deny = (config.deny ?? []).flatMap((entry) => parseEntry(entry));
  rejectOverlaps(allow);
  return {
    allow,
    deny,
    decide(host, addresses) {
      const name = host.trim().toLowerCase().replace(/\.$/, '');
      if (name === 'core' || name === 'core.local') {
        return { allowed: false, reason: 'core is never reachable from the sandbox' };
      }
      const normalized = addresses.map(normalizeAddress);
      if (normalized.length === 0) return { allowed: false, reason: 'the host did not resolve' };

      // An address that is always blocked wins over every rule; one bad answer refuses the whole
      // request, so a name resolving to a public and a private address cannot slip through.
      for (const address of normalized) {
        const blocked = blockedReason(address);
        if (blocked) {
          return {
            allowed: false,
            reason: `${formatIp(address)} is ${blocked}`,
            address,
          };
        }
      }
      if (nameMatches(deny, name))
        return { allowed: false, reason: 'the host is on the deny list' };
      for (const address of normalized) {
        if (cidrMatches(deny, address)) {
          return {
            allowed: false,
            reason: `${formatIp(address)} is on the deny list`,
            address,
          };
        }
      }
      if (allow.length > 0) {
        const byName = nameMatches(allow, name);
        const byRange = normalized.every((address) => cidrMatches(allow, address));
        if (!byName && !byRange) {
          return { allowed: false, reason: 'the host is not on the allow list' };
        }
      }
      return { allowed: true, address: normalized[0]!, addresses: normalized };
    },
  };
}

/** Parses one list entry, with a message that names it; also refuses a wildcard in the middle. */
function parseEntry(entry: string): RuleEntry[] {
  const source = entry.trim();
  if (source === '') throw new Error('an egress rule entry is empty');
  if (parseIp(source)) return [{ kind: 'cidr', range: parseCidr(source), source }];
  if (/^[0-9a-fA-F:.]+\/\d+$/.test(source)) {
    try {
      return [{ kind: 'cidr', range: parseCidr(source), source }];
    } catch (error) {
      throw new Error(`"${source}" is not a valid CIDR range: ${(error as Error).message}`);
    }
  }
  const wildcard = source.startsWith('*.');
  const host = (wildcard ? source.slice(2) : source).toLowerCase().replace(/\.$/, '');
  if (!isHostname(host)) {
    throw new Error(`"${source}" is not a domain, a *.wildcard or an address range`);
  }
  return [{ kind: 'domain', host, wildcard, source }];
}

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
}

function nameMatches(entries: readonly RuleEntry[], host: string): boolean {
  return entries.some((entry) => {
    if (entry.kind !== 'domain') return false;
    return entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
  });
}

function cidrMatches(entries: readonly RuleEntry[], address: IpAddress): boolean {
  return entries.some((entry) => entry.kind === 'cidr' && rangeContains(entry.range, address));
}

/** An allow range that overlaps an always-blocked one would promise something the proxy refuses. */
function rejectOverlaps(allow: readonly RuleEntry[]): void {
  for (const entry of allow) {
    if (entry.kind !== 'cidr') continue;
    for (const blocked of ALWAYS_BLOCKED) {
      if (rangesOverlap(entry.range, blocked.range)) {
        throw new Error(
          `allow entry "${entry.source}" overlaps ${blocked.label} (${blocked.range.source}), ` +
            'which the sandbox never reaches',
        );
      }
    }
  }
}
