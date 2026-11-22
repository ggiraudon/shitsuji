import { configFromEnv } from './config.js';
import { A11yService, a11yHelperArgv } from './a11y.js';
import { DesktopService, SetprivDesktopRunner } from './desktop.js';
import { ExecSupervisor, setprivCommand } from './exec.js';
import { SandboxFilesService } from './files.js';
import { SandboxPaths } from './paths.js';
import { createSandboxServer } from './server.js';

/** sandboxd: the files API and the exec supervisor inside one sandbox (F08, S45–S46). */
async function main(): Promise<void> {
  const config = configFromEnv();
  // Files the daemon creates stay group-writable for the commands (same group, uid 1000).
  process.umask(0o0002);
  const paths = new SandboxPaths({
    workspace: { dir: config.workspaceRoot },
    handoff: { dir: config.handoffRoot, readOnly: true },
  });
  await paths.start();
  const exec = new ExecSupervisor(paths, {
    maxTimeoutMs: config.maxTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    env: {
      PATH: config.commandPath,
      HOME: config.commandHome,
      LANG: 'C.UTF-8',
      USER: config.commandUser,
      ...(config.commandProxy && { proxy: config.commandProxy }),
    },
    ...(config.commandUid !== undefined && {
      wrap: (argv) =>
        setprivCommand(argv, {
          uid: config.commandUid!,
          ...(config.commandGid !== undefined && { gid: config.commandGid }),
          setprivPath: config.setprivPath,
        }),
    }),
  });
  const log = (level: 'info' | 'warn', message: string) => {
    if (level === 'warn') console.warn(`sandboxd: ${message}`);
    else console.log(`sandboxd: ${message}`);
  };
  const a11y = config.desktopEnabled
    ? new A11yService({
        command:
          config.commandUid !== undefined
            ? setprivCommand(a11yHelperArgv(config.desktopA11yPython, config.desktopA11yHelper), {
                uid: config.commandUid,
                ...(config.commandGid !== undefined && { gid: config.commandGid }),
                setprivPath: config.setprivPath,
              })
            : a11yHelperArgv(config.desktopA11yPython, config.desktopA11yHelper),
        env: {
          PATH: config.commandPath,
          HOME: config.commandHome,
          LANG: 'C.UTF-8',
          USER: config.commandUser,
          DISPLAY: config.display,
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-session',
          XDG_RUNTIME_DIR: '/tmp/runtime-agent',
        },
        timeoutMs: config.desktopA11yTimeoutMs,
        maxLineBytes: config.desktopA11yMaxLineBytes,
        log,
      })
    : undefined;
  if (a11y) {
    // The helper must be up before /capabilities claims accessibility (S54). A failed
    // start is not fatal: the desktop still takes screenshots, and a later request retries.
    if (await a11y.start()) await a11y.startupCheck();
    else log('warn', 'The accessibility helper did not start; desktop.inspect is unavailable.');
  }
  const server = createSandboxServer({
    token: config.token,
    files: new SandboxFilesService(paths),
    exec,
    maxBodyBytes: config.maxBodyBytes,
    vncPasswordsFile: config.vncPasswordsFile,
    ...(a11y && { a11y }),
    ...(config.desktopEnabled && {
      desktop: new DesktopService({
        display: config.display,
        runner: new SetprivDesktopRunner({
          uid: config.commandUid ?? 1000,
          gid: config.commandGid ?? 1000,
          setprivPath: config.setprivPath,
          env: {
            PATH: config.commandPath,
            HOME: config.commandHome,
            LANG: 'C.UTF-8',
            USER: config.commandUser,
            DISPLAY: config.display,
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-session',
            XDG_RUNTIME_DIR: '/tmp/runtime-agent',
          },
          timeoutMs: config.desktopTimeoutMs,
          maxOutputBytes: config.desktopMaxOutputBytes,
          maxBinaryBytes: config.desktopMaxBinaryBytes,
        }),
      }),
    }),
  });
  server.listen(config.port, '0.0.0.0', () => {
    // The token is never logged.
    console.log(`sandboxd listening on 0.0.0.0:${config.port}`);
  });
  const stop = () => {
    exec.stopAll();
    a11y?.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(`sandboxd: ${error instanceof Error ? error.message : 'cannot start'}`);
  process.exit(1);
});
