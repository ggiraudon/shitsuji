import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApi, type ApiDeps } from '../interfaces/http/createApi.js';

export interface RunningApi {
  url: string;
  close(): Promise<void>;
}

/** Starts the HTTP + WebSocket API (S24) on host:port. Port 0 picks a free port (tests). */
export async function startApiServer(
  deps: Omit<ApiDeps, 'webSocket'>,
  options: { host: string; port: number },
): Promise<RunningApi> {
  let inject:
    | ((server: Parameters<ReturnType<typeof createNodeWebSocket>['injectWebSocket']>[0]) => void)
    | undefined;
  const app = createApi({
    ...deps,
    webSocket: (a) => {
      const ws = createNodeWebSocket({ app: a });
      inject = ws.injectWebSocket;
      return ws.upgradeWebSocket;
    },
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () =>
      resolve(s),
    );
    s.once('error', reject);
  });
  inject?.(server);
  const address = server.address() as AddressInfo;
  const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // WebSockets keep the server open; end them so shutdown does not wait.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
