import { describe, expect, it } from 'vitest';
import { EgressProbe, type EgressTarget } from '../../../src/application/sandbox/EgressProbe.js';
import { SandboxUnavailable } from '../../../src/domain/errors.js';
import type { Sandbox, SandboxCapabilities } from '../../../src/ports/SandboxDriver.js';
import { testServices } from '../../helpers.js';

const TARGETS: EgressTarget[] = [
  { label: 'LAN', host: '192.168.1.1', port: 80 },
  { label: "core's API", host: '127.0.0.1', port: 3001 },
  { label: 'postgres', host: 'postgres', port: 5432 },
];

const capabilities = (lanBlocked: boolean): SandboxCapabilities => ({
  files: { roots: ['/workspace'] },
  egress: { lanBlocked, credentialSwap: false },
});

/** A sandbox whose egress answers from a set of reachable hosts; an empty set reaches nothing. */
const sandbox = (reachable: readonly string[]): Sandbox => ({
  egress: {
    reachable: async (host) => reachable.includes(host),
  },
  close: async () => undefined,
});

const probe = (options: { requireIsolation?: boolean } = {}) => {
  const services = testServices();
  return {
    egress: new EgressProbe({
      targets: TARGETS,
      timeoutMs: 10,
      log: services.log,
      ...options,
    }),
    log: services.log,
  };
};

describe('EgressProbe (F08, S42)', () => {
  it('accepts a driver that claims lanBlocked when nothing is reachable', async () => {
    const { egress } = probe();

    await expect(egress.check(sandbox([]), capabilities(true), 'shitsuji')).resolves.toEqual({
      lanBlocked: true,
      reachable: [],
    });
  });

  it('refuses a driver that claims lanBlocked while an address answers, naming it', async () => {
    const { egress } = probe();

    const error = await egress
      .check(sandbox(['192.168.1.1']), capabilities(true), 'shitsuji')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxUnavailable);
    expect((error as Error).message).toContain('lanBlocked');
    expect((error as Error).message).toContain('192.168.1.1:80');
  });

  it('refuses a lanBlocked claim that cannot be checked at all', async () => {
    const { egress } = probe();
    const noProbe: Sandbox = { close: async () => undefined };

    await expect(egress.check(noProbe, capabilities(true), 'shitsuji')).rejects.toThrow(
      /cannot be checked/,
    );
  });

  it('accepts a host-like driver with network, saying it makes no claim', async () => {
    const { egress, log } = probe();

    await expect(
      egress.check(sandbox(['127.0.0.1', '192.168.1.1']), capabilities(false), 'host'),
    ).resolves.toEqual({
      lanBlocked: false,
      reachable: [TARGETS[0], TARGETS[1]],
    });
    const warning = log.records.find((record) => record.message.includes('no isolation claim'));
    expect(warning?.context).toMatchObject({ driver: 'host' });
  });

  it('refuses an unisolated driver with network when isolation is required', async () => {
    const { egress } = probe({ requireIsolation: true });

    const error = await egress
      .check(sandbox(['127.0.0.1']), capabilities(false), 'host')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxUnavailable);
    expect((error as Error).message).toContain('127.0.0.1:3001');
    expect((error as Error).message).toContain('requireIsolation');
  });

  it('says nothing when an unisolated driver has no network', async () => {
    const { egress, log } = probe();

    await expect(egress.check(sandbox([]), capabilities(false), 'host')).resolves.toEqual({
      lanBlocked: false,
      reachable: [],
    });
    expect(log.records.filter((record) => record.message.includes('no isolation claim'))).toEqual(
      [],
    );
  });
});
