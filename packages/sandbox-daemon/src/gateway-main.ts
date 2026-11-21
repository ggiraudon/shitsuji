import { gatewayConfigFromEnv, startGateways } from './gateway-config.js';

const log = {
  info(message: string, context?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', message, ...context }));
  },
  warn(message: string, context?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', message, ...context }));
  },
};

/** The core-to-sandbox relays (F08, S48; the viewer stream in S51); see gateway.ts. */
function main(): void {
  const servers = startGateways(gatewayConfigFromEnv(), log);
  const stop = () => {
    let pending = servers.length;
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) process.exit(0);
      });
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  main();
} catch (error) {
  console.error(`sandboxd gateway: ${error instanceof Error ? error.message : 'cannot start'}`);
  process.exit(1);
}
