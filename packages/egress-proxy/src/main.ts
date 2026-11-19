import fs from 'node:fs';
import { createPolicy, type EgressPolicy } from './rules.js';
import { createEgressProxy, type ProxyLogger } from './proxy.js';
import { mergeRules, readRulesFile } from './rulesFile.js';

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
  const fromEnv = {
    allow: listOf(process.env.SANDBOX_EGRESS_ALLOW),
    deny: listOf(process.env.SANDBOX_EGRESS_DENY),
  };
  // Core writes sandbox.egress.* here (S48). A missing file is fine: the env lists still apply.
  const file = process.env.SANDBOX_EGRESS_FILE?.trim() || undefined;
  let policy = createPolicy(mergeRules(fromEnv, file ? readRulesFile(file) : undefined));

  // The proxy keeps this delegating object, so a reload swaps the policy without a restart.
  const current: EgressPolicy = {
    get allow() {
      return policy.allow;
    },
    get deny() {
      return policy.deny;
    },
    decide: (host, addresses) => policy.decide(host, addresses),
  };

  const port = Number(process.env.SANDBOX_EGRESS_PORT ?? 3128);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SANDBOX_EGRESS_PORT must be a port number between 1 and 65535.');
  }

  const server = createEgressProxy({ policy: current, log });
  server.listen(port, '0.0.0.0', () => {
    log.info('egress-proxy listening', {
      port,
      mode: policy.allow.length > 0 ? 'allow-list' : 'open',
      allow: policy.allow.length,
      deny: policy.deny.length,
      ...(file && { rulesFile: file }),
    });
  });

  if (file) {
    // A bind-mounted file changes in place, so poll it; a bad edit keeps the policy already in
    // force rather than widening it.
    fs.watchFile(file, { interval: 2_000, persistent: false }, () => {
      try {
        policy = createPolicy(mergeRules(fromEnv, readRulesFile(file)));
        log.info('egress rules reloaded', {
          mode: policy.allow.length > 0 ? 'allow-list' : 'open',
          allow: policy.allow.length,
          deny: policy.deny.length,
        });
      } catch (error) {
        log.warn('ignored an invalid egress rules change', {
          reason: error instanceof Error ? error.message : 'unknown error',
        });
      }
    });
  }

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
