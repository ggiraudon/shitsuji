import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApi, type ApiDeps } from '../interfaces/http/createApi.js';

export interface RunningApi {
  url: string;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  /** The interface to bind; 127.0.0.1 by default (Y2). */
  listen: string;
  port: number;
  /** Both files, or neither; when set the API is served over HTTPS. */
  tls?: { cert: string; key: string };
}

/** True for the binds that stay on this machine, where plain HTTP is not exposed. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === 'localhost'
  );
}

/** Starts the HTTP + WebSocket API (S24) on listen:port. Port 0 picks a free port (tests). */
export async function startApiServer(
  deps: Omit<ApiDeps, 'webSocket'>,
  options: ApiServerOptions,
): Promise<RunningApi> {
  let inject:
    | ((server: Parameters<ReturnType<typeof createNodeWebSocket>['injectWebSocket']>[0]) => void)
    | undefined;
  const tls = options.tls
    ? { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) }
    : undefined;
  // One warning, at the place that knows the effective bind (Y2).
  if (!tls && !isLoopbackHost(options.listen)) {
    deps.log.warn('API is bound beyond loopback without TLS', { listen: options.listen });
  }
  const app = createApi({
    ...deps,
    webSocket: (a) => {
      const ws = createNodeWebSocket({ app: a });
      inject = ws.injectWebSocket;
      return ws.upgradeWebSocket;
    },
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: options.listen,
        port: options.port,
        ...(tls && {
          createServer: createHttpsServer,
          serverOptions: { cert: tls.cert, key: tls.key },
        }),
      },
      () => resolve(s),
    );
    s.once('error', reject);
  });
  inject?.(server);
  const address = server.address() as AddressInfo;
  const host =
    options.listen === '0.0.0.0' || options.listen === '::' ? '127.0.0.1' : options.listen;
  return {
    url: `${tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // WebSockets keep the server open; end them so shutdown does not wait.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
