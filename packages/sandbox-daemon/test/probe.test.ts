import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probePort } from '../src/probe.js';

let server: net.Server;
let port: number;

beforeEach(async () => {
  server = net.createServer((socket) => socket.end());
  port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sandboxd port probe (S48)', () => {
  it('reports a listening port as reachable, and a closed one as not', async () => {
    expect(await probePort('127.0.0.1', port, 1_000)).toBe(true);
    expect(await probePort('127.0.0.1', 1, 300)).toBe(false);
    expect(await probePort('no-such-host.invalid', 80, 300)).toBe(false);
  });
});
