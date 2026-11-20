import { createGateway, type GatewayLogger } from './gateway.js';

const log: GatewayLogger = {
  info(message, context) {
    console.log(JSON.stringify({ level: 'info', message, ...context }));
  },
  warn(message, context) {
    console.warn(JSON.stringify({ level: 'warn', message, ...context }));
  },
};

/** The core-to-sandboxd relay (F08, S48); see gateway.ts for why it exists. */
function main(): void {
  const port = Number(process.env.SANDBOX_GATEWAY_PORT ?? 4555);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SANDBOX_GATEWAY_PORT must be a port number between 1 and 65535.');
  }
  const target = process.env.SANDBOX_GATEWAY_TARGET?.trim() || 'sandbox:4555';
  const separator = target.lastIndexOf(':');
  const host = target.slice(0, separator);
  const targetPort = Number(target.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    throw new Error('SANDBOX_GATEWAY_TARGET must be host:port.');
  }

  const server = createGateway({ targetHost: host, targetPort, log });
  server.listen(port, '0.0.0.0', () => {
    log.info('sandboxd gateway listening', { port, target });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  main();
} catch (error) {
  console.error(`sandboxd gateway: ${error instanceof Error ? error.message : 'cannot start'}`);
  process.exit(1);
}
