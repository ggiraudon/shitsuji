import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import {
  startApiServer,
  isLoopbackHost,
  type RunningApi,
} from '../../src/composition/apiServer.js';
import type { ApiDeps } from '../../src/interfaces/http/createApi.js';

const KEY = 'owner-key';
const OWNER = asId<OwnerId>('owner');

let upstream: WebSocketServer;
let upstreamPort: number;
let connections = 0;
let api: RunningApi;

const setupApi = (cookieTtlMs = 60_000): Promise<RunningApi> => {
  return startApiServer(
    {
      agent: {},
      repos: {},
      events: {},
      clock: { now: () => new Date() },
      log: new MemoryLogger(),
      ownerId: OWNER,
      soul: {},
      pairing: {},
      approvals: {},
      verifyKey: (key: string | undefined) => key === KEY,
      viewer: {
        credentials: async () => ({ viewOnlyPassword: 'view-only-pass' }),
        stream: { host: '127.0.0.1', port: upstreamPort },
        cookieSecure: false,
        cookieTtlMs,
      },
    } as unknown as Omit<ApiDeps, 'webSocket'>,
    { listen: '127.0.0.1', port: 0 },
  );
};

const signIn = async (): Promise<string> => {
  const response = await fetch(`${api.url}/desktop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `key=${KEY}`,
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  return response.headers.getSetCookie()[0]!.split(';')[0]!;
};

const upgradeStatus = (options: { cookie?: string; origin?: string } = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${api.url.replace('http', 'ws')}/desktop/stream`, {
      headers: {
        ...(options.cookie && { cookie: options.cookie }),
        ...(options.origin && { origin: options.origin }),
      },
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('the upgrade should have been refused'));
    });
    ws.on('error', () => undefined);
  });

const echo = (cookie: string, origin?: string): Promise<{ banner: string; echoed: string }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${api.url.replace('http', 'ws')}/desktop/stream`, {
      headers: { cookie, ...(origin && { origin }) },
    });
    const messages: string[] = [];
    ws.on('message', (data) => {
      messages.push(data.toString());
      if (messages.length === 1) ws.send('ping');
      if (messages.length === 2) {
        ws.close();
        resolve({ banner: messages[0]!, echoed: messages[1]! });
      }
    });
    ws.on('error', reject);
  });

beforeEach(async () => {
  connections = 0;
  upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  upstream.on('connection', (socket) => {
    connections += 1;
    socket.send('banner\n');
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  api = await setupApi();
});

afterEach(async () => {
  await api.close();
  for (const client of upstream.clients) client.terminate();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('desktop viewer WebSocket relay (S51)', () => {
  it('refuses the upgrade without a cookie', async () => {
    await expect(upgradeStatus()).resolves.toBe(401);
    expect(connections).toBe(0);
  });

  it('relays bytes both ways after the owner signs in', async () => {
    const cookie = await signIn();
    const { banner, echoed } = await echo(cookie);
    expect(banner).toBe('banner\n');
    expect(echoed).toBe('echo:ping');
    expect(connections).toBe(1);
  });

  it('refuses a cross-origin stream upgrade, and accepts its own origin (S51)', async () => {
    const cookie = await signIn();
    await expect(upgradeStatus({ cookie, origin: 'http://evil.example' })).resolves.toBe(403);
    expect(connections).toBe(0);

    const { banner } = await echo(cookie, api.url);
    expect(banner).toBe('banner\n');
    expect(connections).toBe(1);
  });

  it('refuses an expired cookie on the upgrade (S51)', async () => {
    await api.close();
    api = await setupApi(100);
    const cookie = await signIn();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(upgradeStatus({ cookie })).resolves.toBe(401);
    expect(connections).toBe(0);
  });

  it('warns once when bound beyond loopback without TLS (Y2)', async () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);

    const log = new MemoryLogger();
    const running = await startApiServer(
      {
        agent: {},
        repos: {},
        events: {},
        clock: { now: () => new Date() },
        log,
        ownerId: OWNER,
        soul: {},
        pairing: {},
        approvals: {},
        verifyKey: (key: string | undefined) => key === KEY,
      } as unknown as Omit<ApiDeps, 'webSocket'>,
      { listen: '0.0.0.0', port: 0, published: '0.0.0.0' },
    );
    expect(
      log.records.filter((record) => record.message === 'API is bound beyond loopback without TLS'),
    ).toHaveLength(1);
    await running.close();

    // Compose binds 0.0.0.0 inside the container but publishes 127.0.0.1: no warning.
    const quietLog = new MemoryLogger();
    const quiet = await startApiServer(
      {
        agent: {},
        repos: {},
        events: {},
        clock: { now: () => new Date() },
        log: quietLog,
        ownerId: OWNER,
        soul: {},
        pairing: {},
        approvals: {},
        verifyKey: (key: string | undefined) => key === KEY,
      } as unknown as Omit<ApiDeps, 'webSocket'>,
      { listen: '0.0.0.0', port: 0, published: '127.0.0.1' },
    );
    expect(
      quietLog.records.filter(
        (record) => record.message === 'API is bound beyond loopback without TLS',
      ),
    ).toHaveLength(0);
    await quiet.close();
  });
});
