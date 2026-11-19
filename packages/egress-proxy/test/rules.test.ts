import { describe, expect, it } from 'vitest';
import { parseIp, type IpAddress } from '../src/address.js';
import { createPolicy } from '../src/rules.js';

const addresses = (...values: string[]): IpAddress[] => values.map((value) => parseIp(value)!);
const publicAddress = addresses('93.184.216.34'); // example.com, in spirit
const decide = (policy: ReturnType<typeof createPolicy>, host: string, ips = publicAddress) =>
  policy.decide(host, ips);

describe('egress policy (X7)', () => {
  it('is open by default for a public address', () => {
    const decision = decide(createPolicy(), 'example.com');

    expect(decision).toMatchObject({ allowed: true, address: publicAddress[0] });
  });

  it('refuses private, loopback, link-local, CGNAT and metadata addresses even with no rules', () => {
    const policy = createPolicy();
    for (const [host, address] of [
      ['lan.test', '192.168.1.1'],
      ['loop.test', '127.0.0.1'],
      ['link.test', '169.254.1.1'],
      ['cgnat.test', '100.64.0.1'],
      ['metadata.test', '169.254.169.254'],
      ['metadata6.test', 'fd00:ec2::254'],
    ] as const) {
      expect(decide(policy, host, addresses(address))).toMatchObject({ allowed: false });
    }
  });

  it('blocks the core service by name, whatever it resolves to', () => {
    expect(decide(createPolicy(), 'core')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/core/),
    });
  });

  it('refuses the whole name when one of several answers is blocked', () => {
    const decision = decide(createPolicy(), 'mixed.test', addresses('93.184.216.34', '10.0.0.5'));

    expect(decision).toMatchObject({ allowed: false, address: parseIp('10.0.0.5') });
  });

  it('allows a listed domain and refuses the rest when an allow list is set', () => {
    const policy = createPolicy({ allow: ['example.com', '*.trusted.org'] });

    expect(decide(policy, 'example.com')).toMatchObject({ allowed: true });
    expect(decide(policy, 'sub.trusted.org')).toMatchObject({ allowed: true });
    expect(decide(policy, 'trusted.org')).toMatchObject({ allowed: false });
    expect(decide(policy, 'other.example')).toMatchObject({ allowed: false });
  });

  it('allows a CIDR range in both families, matched on the resolved address', () => {
    const policy = createPolicy({ allow: ['203.0.113.0/24', '2001:db8::/32'] });

    expect(decide(policy, 'anywhere.test', addresses('203.0.113.9'))).toMatchObject({
      allowed: true,
    });
    expect(decide(policy, 'anywhere6.test', addresses('2001:db8::1'))).toMatchObject({
      allowed: true,
    });
    expect(decide(policy, 'elsewhere.test', addresses('203.0.114.9'))).toMatchObject({
      allowed: false,
    });
  });

  it('matches an IPv4-mapped answer against an IPv4 range', () => {
    const policy = createPolicy({ allow: ['203.0.113.0/24'] });

    expect(decide(policy, 'mapped.test', addresses('::ffff:203.0.113.7'))).toMatchObject({
      allowed: true,
    });
  });

  it('refuses a name whose every answer must be covered by an allow range', () => {
    const policy = createPolicy({ allow: ['203.0.113.0/24'] });

    expect(decide(policy, 'mixed.test', addresses('203.0.113.9', '198.51.100.9'))).toMatchObject({
      allowed: false,
    });
  });

  it('applies the deny list in both modes, by name and by range', () => {
    const open = createPolicy({ deny: ['ads.example', '198.51.100.0/24'] });
    expect(decide(open, 'ads.example')).toMatchObject({ allowed: false });
    expect(decide(open, 'tracker.test', addresses('198.51.100.9'))).toMatchObject({
      allowed: false,
    });

    const listed = createPolicy({ allow: ['example.com'], deny: ['example.com'] });
    expect(decide(listed, 'example.com')).toMatchObject({ allowed: false });
  });

  it('refuses an allow range that overlaps an always-blocked one at startup', () => {
    for (const entry of ['10.0.0.0/8', '127.0.0.1', '0.0.0.0/0', 'fc00::/7', '169.254.0.0/16']) {
      expect(() => createPolicy({ allow: [entry] }), entry).toThrow(/overlaps/);
    }
    // The blocked ranges themselves are fine on the deny list.
    expect(() => createPolicy({ deny: ['10.0.0.0/8'] })).not.toThrow();
  });

  it('refuses malformed entries with the entry named', () => {
    for (const entry of ['', 'exa mple.com', '*.', '10.0.0.0/33', 'a.*.b']) {
      expect(() => createPolicy({ allow: [entry] }), entry).toThrow(
        new RegExp(entry ? 'entry|not|overlap|prefix' : 'empty'),
      );
    }
  });
});
