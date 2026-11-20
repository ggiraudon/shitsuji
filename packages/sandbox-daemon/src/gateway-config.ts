import type { Server } from 'node:net';
import { createGateway, type GatewayLogger } from './gateway.js';

/** One relay listener: where it listens and where it forwards. */
export interface GatewayListener {
  port: number;
  targetHost: string;
  targetPort: number;
}

export interface GatewayConfig {
  control: GatewayListener;
  /** The view-only WebSocket relay (S51); absent unless the deployment asks for it. */
  viewer?: GatewayListener;
}

/**
 * The gateway's two listeners (S48, S51): the control port for sandboxd, and an optional view-only
 * stream port for websockify. The viewer listener is opt-in so the base gateway stays one port.
 */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const control = listenerFromEnv(env, 'SANDBOX_GATEWAY', 'sandbox:4555');
  const viewerPort = env.SANDBOX_GATEWAY_VIEWER_PORT?.trim();
  if (!viewerPort) return { control };
  const viewer = listenerFromEnv(
    env,
    'SANDBOX_GATEWAY_VIEWER',
    'sandbox:6081',
    'SANDBOX_GATEWAY_VIEWER_PORT',
  );
  if (viewer.port === control.port) {
    throw new Error('SANDBOX_GATEWAY_VIEWER_PORT must differ from SANDBOX_GATEWAY_PORT.');
  }
  return { control, viewer };
}

function listenerFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaultTarget: string,
  portVar = `${prefix}_PORT`,
): GatewayListener {
  const port = Number(env[portVar]?.trim() ?? (prefix === 'SANDBOX_GATEWAY' ? 4555 : NaN));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${portVar} must be a port number between 1 and 65535.`);
  }
  const target = env[`${prefix}_TARGET`]?.trim() || defaultTarget;
  const separator = target.lastIndexOf(':');
  const targetHost = target.slice(0, separator);
  const targetPort = Number(target.slice(separator + 1));
  if (
    separator <= 0 ||
    !targetHost ||
    !Number.isInteger(targetPort) ||
    targetPort < 1 ||
    targetPort > 65_535
  ) {
    throw new Error(`${prefix}_TARGET must be host:port.`);
  }
  return { port, targetHost, targetPort };
}

/** Starts the configured listeners; the caller owns shutdown. */
export function startGateways(config: GatewayConfig, log: GatewayLogger): Server[] {
  const servers: Server[] = [];
  const control = createGateway({
    targetHost: config.control.targetHost,
    targetPort: config.control.targetPort,
    log,
  });
  servers.push(control);
  control.listen(config.control.port, '0.0.0.0', () => {
    log.info('sandboxd gateway listening', {
      port: config.control.port,
      target: `${config.control.targetHost}:${config.control.targetPort}`,
    });
  });
  if (config.viewer) {
    const viewerConfig = config.viewer;
    const viewer = createGateway({
      targetHost: viewerConfig.targetHost,
      targetPort: viewerConfig.targetPort,
      log,
    });
    servers.push(viewer);
    viewer.listen(viewerConfig.port, '0.0.0.0', () => {
      log.info('sandboxd viewer gateway listening', {
        port: viewerConfig.port,
        target: `${viewerConfig.targetHost}:${viewerConfig.targetPort}`,
      });
    });
  }
  return servers;
}
