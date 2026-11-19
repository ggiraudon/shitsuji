import { describe, expect, it } from 'vitest';
import {
  ALWAYS_BLOCKED,
  METADATA_ADDRESSES,
  blockedReason,
  formatIp,
  normalizeAddress,
  parseCidr,
  parseIp,
  rangeContains,
  rangesOverlap,
} from '../src/address.js';

const ip = (value: string) => parseIp(value)!;

describe('address parsing (F08, S47)', () => {
  it('formats IPv4 and IPv6 and normalizes IPv4-mapped IPv6', () => {
    expect(formatIp(ip('192.168.1.10'))).toBe('192.168.1.10');
    expect(formatIp(normalizeAddress(ip('::ffff:192.168.1.10')))).toBe('192.168.1.10');
    expect(normalizeAddress(ip('::ffff:8.8.8.8'))).toEqual(ip('8.8.8.8'));
    expect(normalizeAddress(ip('2001:db8::1')).family).toBe(6);
  });

  it('refuses a zone suffix and anything that is not an address', () => {
    expect(parseIp('fe80::1%eth0')).toBeUndefined();
    expect(parseIp('example.com')).toBeUndefined();
    expect(parseIp('')).toBeUndefined();
  });

  it('matches CIDR ranges in both families, and a bare IP as one host', () => {
    expect(rangeContains(parseCidr('10.0.0.0/8'), ip('10.1.2.3'))).toBe(true);
    expect(rangeContains(parseCidr('10.0.0.0/8'), ip('11.1.2.3'))).toBe(false);
    expect(rangeContains(parseCidr('2001:db8::/32'), ip('2001:db8::5'))).toBe(true);
    expect(rangeContains(parseCidr('2001:db8::/32'), ip('2001:db9::5'))).toBe(false);
    expect(rangeContains(parseCidr('8.8.8.8'), ip('8.8.8.8'))).toBe(true);
    expect(rangeContains(parseCidr('8.8.8.8'), ip('8.8.8.9'))).toBe(false);
    // An IPv4-mapped address is the IPv4 one, so it matches an IPv4 range.
    expect(rangeContains(parseCidr('8.8.8.0/24'), ip('::ffff:8.8.8.8'))).toBe(true);
  });

  it('detects overlapping ranges across the blocked set', () => {
    expect(rangesOverlap(parseCidr('10.0.0.0/8'), parseCidr('10.1.0.0/16'))).toBe(true);
    expect(rangesOverlap(parseCidr('10.0.0.0/8'), parseCidr('11.0.0.0/8'))).toBe(false);
    expect(rangesOverlap(parseCidr('10.0.0.0/8'), parseCidr('2001:db8::/32'))).toBe(false);
  });

  it('refuses a bad prefix and a bad entry', () => {
    expect(() => parseCidr('10.0.0.0/33')).toThrow(/prefix/);
    expect(() => parseCidr('2001:db8::/129')).toThrow(/prefix/);
    expect(() => parseCidr('not-a-range')).toThrow(/not an address/);
    // A range is masked to its network address.
    expect(parseCidr('192.168.1.77/24').start).toBe(ip('192.168.1.0').value);
  });
});

describe('always-blocked addresses (X7)', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.5.4', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['169.254.1.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['fc00::1', 'private'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
  ])('blocks %s (%s)', (address, label) => {
    expect(blockedReason(ip(address))).toBe(label);
  });

  it('blocks IPv4-mapped copies of a blocked address', () => {
    expect(blockedReason(ip('::ffff:127.0.0.1'))).toBe('loopback');
    expect(blockedReason(ip('::ffff:192.168.0.1'))).toBe('private');
  });

  it('names cloud metadata explicitly, with its own label', () => {
    for (const entry of METADATA_ADDRESSES) {
      expect(blockedReason(entry.address)).toBe('cloud metadata');
      expect(blockedReason(entry.address)).toBe(entry.label);
    }
    expect(blockedReason(ip('169.254.169.254'))).toBe('cloud metadata');
    expect(blockedReason(ip('fd00:ec2::254'))).toBe('cloud metadata');
  });

  it('lets a public address through', () => {
    expect(blockedReason(ip('8.8.8.8'))).toBeUndefined();
    expect(blockedReason(ip('1.1.1.1'))).toBeUndefined();
    expect(blockedReason(ip('2001:4860:4860::8888'))).toBeUndefined();
    expect(ALWAYS_BLOCKED.length).toBeGreaterThan(10);
  });
});
