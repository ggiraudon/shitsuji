import { startMockServer } from './mockServer.js';

/**
 * `pnpm mock [port]` starts the local mock service the Telegram live check uses (S39). Point
 * `tools.notifyUrl` at `<url>/notify`, then open `<url>/state` to see what the agent sent.
 */
const port = Number(process.argv[2] ?? 8099);
const server = await startMockServer(port);
console.log(`Mock services on ${server.url}`);
console.log(`  POST ${server.url}/notify   the outside action`);
console.log(`  POST ${server.url}/mail     the mock mailbox`);
console.log(`  GET  ${server.url}/state    what arrived`);
console.log('Ctrl+C stops it.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
