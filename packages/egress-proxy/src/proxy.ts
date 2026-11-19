import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { formatIp, parseIp, type IpAddress } from './address.js';
import type { EgressPolicy } from './rules.js';

export interface ProxyLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface EgressProxyDeps {
  policy: EgressPolicy;
  /** Resolves a hostname (tests inject this; no DNS leaves the process). */
  resolve?: (host: string) => Promise<IpAddress[]>;
  /** Connects to the chosen address (tests inject this to assert the pin). */
  connect?: (address: IpAddress, port: number) => net.Socket;
  log: ProxyLogger;
}

interface Refused {
  refused: string;
}

/**
 * The sandbox's only way out (F08, S47): HTTP `CONNECT` for tunnels and plain HTTP forwarding.
 * The hostname is resolved once, every answer is checked by the policy, and the connection goes to
 * the exact address that was checked — a second DNS answer can never swap it (no rebinding).
 */
export function createEgressProxy(deps: EgressProxyDeps): http.Server {
  const resolve = deps.resolve ?? defaultResolve;
  const connect =
    deps.connect ?? ((address, port) => net.connect({ host: formatIp(address), port }));

  const check = async (host: string): Promise<IpAddress | Refused> => {
    let addresses: IpAddress[];
    try {
      addresses = await resolve(host);
    } catch {
      deps.log.warn('Egress refused', { host, reason: 'the name did not resolve' });
      return { refused: 'the host did not resolve' };
    }
    const decision = deps.policy.decide(host, addresses);
    if (!decision.allowed) {
      deps.log.warn('Egress refused', {
        host,
        ...(decision.address && { address: formatIp(decision.address) }),
        reason: decision.reason,
      });
      return { refused: decision.reason };
    }
    return decision.address;
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (!req.url || !/^https?:\/\//i.test(req.url)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('This is a proxy; send an absolute URL or CONNECT.');
    }
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('Use CONNECT for HTTPS.');
      return;
    }
    void forward(req, res, url);
  });

  async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const port = Number(url.port || 80);
    const address = await check(url.hostname);
    if ('refused' in address) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`Blocked by the sandbox egress policy: ${address.refused}`);
      return;
    }
    const headers = { ...req.headers, host: url.host };
    const upstream = http.request(
      {
        host: formatIp(address),
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('The target refused the connection.');
      } else res.end();
    });
    req.pipe(upstream);
  }

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on('error', () => undefined);
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    void tunnel(clientSocket, target.host, target.port, head);
  });

  async function tunnel(
    clientSocket: net.Socket,
    host: string,
    port: number,
    head: Buffer,
  ): Promise<void> {
    const address = await check(host);
    if ('refused' in address) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(address, port);
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once('error', () => {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    clientSocket.once('close', () => upstream.destroy());
  }

  return server;
}

async function defaultResolve(host: string): Promise<IpAddress[]> {
  const literal = parseIp(host);
  if (literal) return [literal];
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => parseIp(answer.address)).filter((a): a is IpAddress => !!a);
}

/** `host:port`, `[v6]:port`; the default tunnel port is 443. */
export function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const value = authority.trim();
  const match = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (match) {
    return { host: match[1]!, port: match[2] ? Number(match[2]) : 443 };
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return { host: value, port: 443 };
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host, port };
}
