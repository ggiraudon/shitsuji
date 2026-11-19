import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatIp, parseIp, type IpAddress } from '../src/address.js';
import { createEgressProxy, parseAuthority, unbracket, type ProxyLogger } from '../src/proxy.js';
import { createPolicy, type EgressPolicy } from '../src/rules.js';

const LOOPBACK = parseIp('127.0.0.1')!;

const logger = (): ProxyLogger & {
  warnings: { message: string; context?: Record<string, unknown> }[];
} => {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  return {
    warnings,
    info: () => undefined,
    warn: (message, context) => warnings.push({ message, ...(context && { context }) }),
  };
};

const policyAllowing = (): EgressPolicy => ({
  allow: [],
  deny: [],
  decide: (_host: string, addresses: readonly IpAddress[]) => ({
    allowed: true,
    address: addresses[0] ?? LOOPBACK,
    addresses,
  }),
});

const policyRefusing = (reason: string): EgressPolicy => ({
  allow: [],
  deny: [],
  decide: () => ({ allowed: false, reason }),
});

let target: http.Server;
let proxy: http.Server;
let targetPort: number;
let proxyPort: number;
let targetRequests: { method?: string; url?: string; host?: string }[];
let proxyLog: ReturnType<typeof logger>;

const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

const startProxy = async (policy: EgressPolicy) => {
  proxyLog = logger();
  proxy = createEgressProxy({
    policy,
    log: proxyLog,
    resolve: async () => [LOOPBACK],
  });
  proxyPort = await listen(proxy);
};

/** Sends an absolute-form request through the proxy, the way curl does. */
const throughProxy = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path,
        method: 'GET',
        headers: { host: `pinned.test:${targetPort}`, ...headers },
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });

/** Opens a CONNECT tunnel, sends one request through it and collects what comes back. */
const tunnel = (authority: string) =>
  new Promise<{ status: string; body: string }>((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buffer = '';
    let established: string | undefined;
    let afterConnect = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (afterConnect) return;
      if (!buffer.includes('\r\n\r\n')) return;
      established = buffer.split('\r\n')[0]!;
      buffer = '';
      if (established !== 'HTTP/1.1 200 Connection Established') {
        socket.destroy();
        resolve({ status: established, body: '' });
        return;
      }
      afterConnect = true;
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: pinned.test\r\nConnection: close\r\n\r\n`);
    });
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.on('close', () => resolve({ status: established ?? '', body: buffer }));
  });

beforeEach(async () => {
  targetRequests = [];
  target = http.createServer((req, res) => {
    targetRequests.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ done: true, url: req.url }));
  });
  targetPort = await listen(target);
});

afterEach(async () => {
  proxy.closeAllConnections?.();
  target.closeAllConnections?.();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe('egress proxy (F08, S47)', () => {
  it('forwards a plain HTTP request to the pinned address, keeping the Host', async () => {
    await startProxy(policyAllowing());

    const response = await throughProxy(`http://pinned.test:${targetPort}/hello?x=1`);

    expect(response.status).toBe(200);
    expect(targetRequests).toEqual([
      { method: 'GET', url: '/hello?x=1', host: `pinned.test:${targetPort}` },
    ]);
  });

  it('tunnels a CONNECT to the pinned address', async () => {
    await startProxy(policyAllowing());

    const response = await tunnel(`pinned.test:${targetPort}`);

    expect(response.status).toBe('HTTP/1.1 200 Connection Established');
    expect(response.body).toContain('"done":true');
    expect(targetRequests[0]).toMatchObject({ url: '/tunnel' });
  });

  it('refuses with 403 and logs the host and reason, never the content', async () => {
    await startProxy(policyRefusing('10.0.0.5 is private'));

    const response = await throughProxy(`http://blocked.test:${targetPort}/secret?token=abc`);

    expect(response.status).toBe(403);
    expect(response.body).toContain('Blocked by the sandbox egress policy');
    expect(targetRequests).toHaveLength(0);
    expect(proxyLog.warnings.at(-1)).toMatchObject({
      message: 'Egress refused',
      context: { host: 'blocked.test', reason: '10.0.0.5 is private' },
    });
    expect(JSON.stringify(proxyLog.warnings)).not.toContain('token=abc');
  });

  it('refuses a CONNECT with 403 when the policy says no', async () => {
    await startProxy(policyRefusing('loopback'));

    const response = await tunnel(`pinned.test:${targetPort}`);

    expect(response.status).toBe('HTTP/1.1 403 Forbidden');
    expect(targetRequests).toHaveLength(0);
  });

  it('answers health and refuses an origin-form request that is not a proxy request', async () => {
    await startProxy(policyAllowing());

    const health = await new Promise<number>((resolve) =>
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: '/health' }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
        .on('error', () => resolve(0)),
    );
    expect(health).toBe(200);

    const notAProxy = await new Promise<number>((resolve) =>
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: '/hello' }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
        .on('error', () => resolve(0)),
    );
    expect(notAProxy).toBe(400);
  });

  it('parses CONNECT authorities, including bracketed IPv6 and the default port', () => {
    expect(parseAuthority('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
    expect(parseAuthority('example.com')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
    expect(parseAuthority('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 443 });
    expect(parseAuthority('example.com:0')).toBeUndefined();
    expect(parseAuthority('example.com:nope')).toBeUndefined();
    expect(unbracket('[::1]')).toBe('::1');
    expect(unbracket('example.com')).toBe('example.com');
  });

  it('classifies a bracketed IPv6 literal as an address, not a name (#90)', async () => {
    const resolved: string[] = [];
    proxyLog = logger();
    proxy = createEgressProxy({
      policy: policyAllowing(),
      log: proxyLog,
      resolve: async (host) => {
        resolved.push(host);
        return [LOOPBACK];
      },
    });
    proxyPort = await listen(proxy);

    // The URL parser keeps the brackets in `hostname`; the proxy must strip them and connect.
    const response = await throughProxy(`http://[2606:2800:220:1::]:${targetPort}/v6`);

    expect(response.status).toBe(200);
    expect(resolved).toEqual(['2606:2800:220:1::']);
  });

  it('refuses a bracketed loopback CONNECT without treating it as a name (#90)', async () => {
    proxyLog = logger();
    proxy = createEgressProxy({ policy: createPolicy(), log: proxyLog });
    proxyPort = await listen(proxy);

    const response = await tunnel(`[::1]:${targetPort}`);

    expect(response.status).toBe('HTTP/1.1 403 Forbidden');
    // A parsed literal is refused as loopback; a name would have failed to resolve instead.
    expect(proxyLog.warnings.at(-1)).toMatchObject({
      context: { host: '::1', address: '::1', reason: '::1 is loopback' },
    });
  });

  it('connects to the address it checked, not to a second DNS answer', async () => {
    const resolved: string[] = [];
    proxyLog = logger();
    proxy = createEgressProxy({
      policy: policyAllowing(),
      log: proxyLog,
      resolve: async (host) => {
        resolved.push(host);
        // A name that does not exist on this machine: only the pinned answer can connect.
        return resolved.length === 1 ? [LOOPBACK] : [parseIp('192.0.2.1')!];
      },
    });
    proxyPort = await listen(proxy);

    const response = await throughProxy(`http://pinned.test:${targetPort}/once`);

    expect(response.status).toBe(200);
    expect(resolved).toEqual(['pinned.test']);
    expect(formatIp(LOOPBACK)).toBe('127.0.0.1');
  });
});
