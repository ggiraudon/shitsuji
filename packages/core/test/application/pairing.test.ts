import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { PairingService } from '../../src/application/channels/PairingService.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';

const owner = asId<OwnerId>('owner');
const other = asId<OwnerId>('other');

const setup = (codes = ['abcd2345', 'efgh6789']) => {
  const clock = new ManualClock('2026-03-01T10:00:00.000Z');
  let next = 0;
  return {
    clock,
    pairing: new PairingService(clock, {
      code: () => codes[Math.min(next++, codes.length - 1)]!,
    }),
  };
};

describe('PairingService (S31)', () => {
  it('issues an unambiguous code that expires after ten minutes', () => {
    const { pairing } = setup();
    const { code, expiresAt } = pairing.issue(owner);
    expect(code).toBe('ABCD2345');
    expect(expiresAt).toEqual(new Date('2026-03-01T10:10:00.000Z'));
  });

  it('consumes a code once and returns its owner', () => {
    const { pairing } = setup();
    const { code } = pairing.issue(owner);
    expect(pairing.consume(` ${code.toLowerCase()} `)).toBe(owner);
    expect(pairing.consume(code)).toBeUndefined();
  });

  it('refuses an expired, unknown or other code', () => {
    const { clock, pairing } = setup();
    const first = pairing.issue(owner);
    const second = pairing.issue(other);
    clock.advance(10 * 60_000 + 1);

    expect(pairing.consume(first.code)).toBeUndefined();
    expect(pairing.consume('NOPE2345')).toBeUndefined();
    expect(pairing.consume(second.code)).toBeUndefined();
  });

  it('generates distinct codes when no generator is injected', () => {
    const pairing = new PairingService(new ManualClock());
    const codes = new Set([pairing.issue(owner).code, pairing.issue(owner).code]);
    expect(codes.size).toBe(2);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
