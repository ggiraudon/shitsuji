#!/usr/bin/env node
import 'dotenv/config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fork, type ChildProcess } from 'child_process';
import { createWriteStream } from 'fs';

const args = process.argv.slice(2);
const command = args[0] || 'server';
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (command === 'daemon') {
    const logFile = args.find((a) => a.startsWith('--log='))?.split('=')[1] || './shitsuji.log';
    const indexPath = join(__dirname, 'index.js');

    const child: ChildProcess = fork(indexPath, ['--daemon'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    });

    const logStream = createWriteStream(logFile, { flags: 'a' });

    child.stdout?.on('data', (data: Buffer) => {
      logStream.write(data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      logStream.write(data);
    });

    child.on('exit', (code) => {
      logStream.write(`Process exited with code ${code}\n`);
      logStream.end();
      process.exit(code ?? 1);
    });

    console.log(`Shitsuji daemon started (PID: ${child.pid})`);
    console.log(`Logging to: ${logFile}`);
    process.exit(0);
  }

  if (command === 'tui') {
    // The TUI is a client of the running core's API (S25): start core first.
    const { startTUI } = await import('./interfaces/tui/app.js');
    const { loadConfig } = await import('./composition/config/loadConfig.js');
    const { connectTui } = await import('./composition/tuiConnection.js');
    const { config } = loadConfig();
    await startTUI(await connectTui(config));
    return;
  }

  // Default: server mode
  const { startServer } = await import('./index.js');
  await startServer();
}

main().catch((err: unknown) => {
  // Configuration problems are the user's to fix: show the message, not a stack trace.
  if (err instanceof Error && err.name === 'ConfigError') console.error(err.message);
  else console.error(err);
  process.exit(1);
});
