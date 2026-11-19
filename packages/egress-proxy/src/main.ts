import { createPolicy } from './rules.js';
import { createEgressProxy, type ProxyLogger } from './proxy.js';

/** Logs refusals and startup without ever touching request content. */
const log: ProxyLogger = {
  info(message, context) {
    console.log(JSON.stringify({ level: 'info', message, ...context }));
  },
  warn(message, context) {
    console.warn(JSON.stringify({ level: 'warn', message, ...context }));
  },
};

/** One list from the environment: comma or whitespace separated, blanks ignored. */
const listOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

function main(): void {
  const allow = listOf(process.env.SANDBOX_EGRESS_ALLOW);
  const deny = listOf(process.env.SANDBOX_EGRESS_DENY);
  const port = Number(process.env.SANDBOX_EGRESS_PORT ?? 3128);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SANDBOX_EGRESS_PORT must be a port number between 1 and 65535.');
  }
  let policy;
  try {
    policy = createPolicy({ allow, deny });
  } catch (error) {
    // A bad rule is a configuration error: refuse to start rather than run with a wider policy.
    throw new Error(`invalid egress rules: ${(error as Error).message}`);
  }
  const server = createEgressProxy({ policy, log });
  server.listen(port, '0.0.0.0', () => {
    log.info('egress-proxy listening', {
      port,
      mode: allow.length > 0 ? 'allow-list' : 'open',
      allow: allow.length,
      deny: deny.length,
    });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  main();
} catch (error) {
  console.error(`egress-proxy: ${error instanceof Error ? error.message : 'cannot start'}`);
  process.exit(1);
}
