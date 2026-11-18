import { configFromEnv } from './config.js';
import { SandboxFilesService } from './files.js';
import { SandboxPaths } from './paths.js';
import { createSandboxServer } from './server.js';

/** sandboxd: the files API inside one sandbox (S45); the exec supervisor joins it in S46. */
async function main(): Promise<void> {
  const config = configFromEnv();
  const paths = new SandboxPaths({
    workspace: { dir: config.workspaceRoot },
    handoff: { dir: config.handoffRoot, readOnly: true },
  });
  await paths.start();
  const server = createSandboxServer({
    token: config.token,
    files: new SandboxFilesService(paths),
    maxBodyBytes: config.maxBodyBytes,
  });
  server.listen(config.port, '0.0.0.0', () => {
    // The token is never logged.
    console.log(`sandboxd listening on 0.0.0.0:${config.port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(`sandboxd: ${error instanceof Error ? error.message : 'cannot start'}`);
  process.exit(1);
});
