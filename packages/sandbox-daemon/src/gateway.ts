import net from 'node:net';

export interface GatewayLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface GatewayOptions {
  /** Where sandboxd listens, e.g. `sandbox` and `4555`. */
  targetHost: string;
  targetPort: number;
  log?: GatewayLogger;
}

/**
 * The one path from core to sandboxd (F08, S48). Core must not join the sandbox network: then the
 * sandbox could dial core's admin API, and the `lanBlocked` probe would rightly refuse the driver.
 * This relay is on both networks and forwards its port to sandboxd; core authenticates with the
 * shared token as before, and the relay never knows it.
 */
export function createGateway(options: GatewayOptions): net.Server {
  return net.createServer((client) => {
    const upstream = net.connect({ host: options.targetHost, port: options.targetPort });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', (error) => {
      options.log?.warn('sandboxd gateway: the target refused', {
        target: `${options.targetHost}:${options.targetPort}`,
        reason: error.message,
      });
      close();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
}
