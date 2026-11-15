import 'dotenv/config';
import { loadConfig } from './composition/config/loadConfig.js';
import { createShitsuji } from './composition/createShitsuji.js';
import type { Shitsuji } from './composition/Shitsuji.js';

export { createShitsuji } from './composition/createShitsuji.js';
export { loadConfig } from './composition/config/loadConfig.js';
export type { Shitsuji } from './composition/Shitsuji.js';

let running: Shitsuji | null = null;

/** Server mode: the CLI and webhook channels, as configured. */
export async function startServer(): Promise<void> {
  const { config, source } = loadConfig();
  running = await createShitsuji(config);
  running.log.info('Configuration loaded', {
    source: source ?? '(defaults and environment)',
    dataDir: config.paths.dataDir,
  });
  await running.start();

  const webhook = config.channels.webhook;
  const url = `http://localhost:${webhook.port}${webhook.path}`;
  const lines = [
    'Shitsuji AI Agent',
    '',
    'Chat with it in another terminal: node packages/core/dist/cli.js tui',
    ...(running.apiUrl ? [`API: ${running.apiUrl}`] : []),
    ...(webhook.enabled ? [`Webhook: ${url}`] : []),
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const row = (text: string) => `║  ${text.padEnd(width - 4)}  ║`;
  console.log(
    ['', `╔${'═'.repeat(width)}╗`, ...lines.map(row), `╚${'═'.repeat(width)}╝`, ''].join('\n'),
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stopServer().finally(() => process.exit(0));
    });
  }
}

export async function stopServer(): Promise<void> {
  await running?.stop();
  running = null;
}
