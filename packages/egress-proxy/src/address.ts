import net from 'node:net';

/** A numeric address: 32 bits for IPv4, 128 for IPv6, so ranges compare as plain bigints. */
export interface IpAddress {
  family: 4 | 6;
  value: bigint;
}

export interface CidrRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
  /** The text the range came from, for errors and logs. */
  source: string;
}

/** Parses an IPv4 or IPv6 literal; a zone suffix (`fe80::1%eth0`) is not an address we accept. */
export function parseIp(input: string): IpAddress | undefined {
  const value = input.trim();
  if (value.includes('%')) return undefined;
  if (net.isIPv4(value)) {
    return { family: 4, value: ipv4ToNumber(value) };
  }
  if (net.isIPv6(value)) {
    return { family: 6, value: ipv6ToNumber(value) };
  }
  return undefined;
}

/**
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is the IPv4 address wearing an IPv6 hat: normalize it so it
 * is tested against IPv4 rules, which is how a proxy is tricked.
 */
export function normalizeAddress(address: IpAddress): IpAddress {
  if (address.family !== 6) return address;
  const masked = address.value >> 32n;
  if (masked === 0xffffn) return { family: 4, value: address.value & 0xffffffffn };
  return address;
}

export function formatIp(address: IpAddress): string {
  if (address.family === 4) return numberToIpv4(address.value);
  return numberToIpv6(address.value);
}

export function parseCidr(input: string): CidrRange {
  const text = input.trim();
  const [addressPart, prefixPart, ...rest] = text.split('/');
  if (rest.length > 0 || !addressPart)
    throw new Error(`"${input}" is not an address or CIDR range`);
  const address = parseIp(addressPart);
  if (!address) throw new Error(`"${input}" is not an address or CIDR range`);
  const bits = address.family === 4 ? 32 : 128;
  const prefix = prefixPart === undefined ? bits : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`"${input}" has a prefix outside 0..${bits}`);
  }
  const hostBits = BigInt(bits - prefix);
  const size = 1n << hostBits;
  const start = (address.value >> hostBits) << hostBits;
  return { family: address.family, start, end: start + size - 1n, source: text };
}

export function rangeContains(range: CidrRange, address: IpAddress): boolean {
  const candidate = normalizeAddress(address);
  return (
    candidate.family === range.family &&
    candidate.value >= range.start &&
    candidate.value <= range.end
  );
}

export function rangesOverlap(a: CidrRange, b: CidrRange): boolean {
  return a.family === b.family && a.start <= b.end && b.start <= a.end;
}

/**
 * What no allow rule can open (X7): this machine, its LAN, link-local (where cloud metadata lives),
 * CGNAT, the unspecified address, multicast and reserved space. The metadata range is also listed
 * on its own, so a regression in the range list cannot silently expose it.
 */
export const ALWAYS_BLOCKED: readonly { label: string; range: CidrRange }[] = [
  { label: 'unspecified', range: parseCidr('0.0.0.0/8') },
  { label: 'loopback', range: parseCidr('127.0.0.0/8') },
  { label: 'private', range: parseCidr('10.0.0.0/8') },
  { label: 'private', range: parseCidr('172.16.0.0/12') },
  { label: 'private', range: parseCidr('192.168.0.0/16') },
  { label: 'cgnat', range: parseCidr('100.64.0.0/10') },
  { label: 'link-local', range: parseCidr('169.254.0.0/16') },
  { label: 'multicast', range: parseCidr('224.0.0.0/4') },
  { label: 'reserved', range: parseCidr('240.0.0.0/4') },
  { label: 'loopback', range: parseCidr('::1/128') },
  { label: 'unspecified', range: parseCidr('::/128') },
  { label: 'private', range: parseCidr('fc00::/7') },
  { label: 'link-local', range: parseCidr('fe80::/10') },
  { label: 'multicast', range: parseCidr('ff00::/8') },
];

/** Cloud metadata, named explicitly so a test can fail loudly if it ever becomes reachable. */
export const METADATA_ADDRESSES: readonly { label: string; address: IpAddress }[] = [
  { label: 'cloud metadata', address: parseIp('169.254.169.254')! },
  { label: 'cloud metadata', address: parseIp('fd00:ec2::254')! },
];

/** The label of the always-blocked range an address falls in, or undefined for a public address. */
export function blockedReason(address: IpAddress): string | undefined {
  const candidate = normalizeAddress(address);
  for (const metadata of METADATA_ADDRESSES) {
    if (
      metadata.address.family === candidate.family &&
      metadata.address.value === candidate.value
    ) {
      return metadata.label;
    }
  }
  return ALWAYS_BLOCKED.find((entry) => rangeContains(entry.range, candidate))?.label;
}

function ipv4ToNumber(address: string): bigint {
  const parts = address.split('.').map(Number);
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function numberToIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

function ipv6ToNumber(address: string): bigint {
  // `net.isIPv6` has already accepted the syntax; expand `::` and the trailing dotted quad.
  const halves = address.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const groups: string[] = [];
  for (const group of head) groups.push(group);
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    for (let i = 0; i < missing; i++) groups.push('0');
  }
  for (const group of tail) groups.push(group);
  let value = 0n;
  for (const group of groups) {
    if (group.includes('.')) {
      const ipv4 = ipv4ToNumber(group);
      value = (value << 32n) | ipv4;
      continue;
    }
    value = (value << 16n) | BigInt(parseInt(group || '0', 16));
  }
  return value;
}

function numberToIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(':');
}
