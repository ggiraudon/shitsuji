import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApi, type ApiDeps } from '../interfaces/http/createApi.js';

/** A listening API server: where it can be reached and how to stop it. */
export interface RunningApi {
  /** The URL to reach it at, with the port the OS actually bound (useful when it was 0). */
  url: string;
  /** Stops accepting connections and ends open WebSockets; resolves once closed. */
  close(): Promise<void>;
}

/** What `startApiServer` needs: the bind address, the port and the optional TLS files. */
export interface ApiServerOptions {
  /** The interface to bind; 127.0.0.1 by default (Y2). */
  listen: string;
  /** The port to bind; 0 asks the OS for a free one. */
  port: number;
  /**
   * The address Docker publishes, when it differs from the bind. The warning follows what the
   * owner actually exposes; Compose binds 0.0.0.0 inside the container but publishes loopback by
   * default (Y2).
   */
  published?: string;
  /** Both files, or neither; when set the API is served over HTTPS. */
  tls?: {
    /** Path to the certificate chain, PEM. */
    cert: string;
    /** Path to the private key, PEM. */
    key: string;
  };
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
  // One warning, at the place that knows what the owner actually exposes (Y2). Compose binds
  // 0.0.0.0 inside the container but publishes 127.0.0.1 by default, which must stay quiet.
  const exposed = options.published?.trim() || options.listen;
  if (!tls && !isLoopbackHost(exposed)) {
    deps.log.warn('API is bound beyond loopback without TLS', {
      listen: options.listen,
      published: exposed,
    });
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
