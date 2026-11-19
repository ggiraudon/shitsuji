import fs from 'node:fs';

/** Where sandboxd finds its settings. The token is the only secret and is never logged. */
export interface SandboxDaemonConfig {
  token: string;
  port: number;
  workspaceRoot: string;
  handoffRoot: string;
  /** The largest request body; a base64 write of a 48 MB file fits. */
  maxBodyBytes: number;
  /** A command may never run longer than this. */
  maxTimeoutMs: number;
  /** Output kept per command; the rest is dropped. */
  maxOutputBytes: number;
  /** Where commands run from: the uid/gid the daemon drops to, and their home. */
  commandUid?: number;
  commandGid?: number;
  commandHome: string;
  /** The name that goes with commandUid in the environment. */
  commandUser: string;
  /** The fixed PATH of a command's environment. */
  commandPath: string;
  /** `setpriv`, which drops each command to the command identity and clears its capabilities. */
  setprivPath: string;
}

/**
 * The token comes from `SANDBOX_TOKEN_FILE` (preferred) or `SANDBOX_TOKEN` (development).
 *
 * A file is preferred because a token in the environment stays readable in `/proc/<pid>/environ`
 * to any process with the same uid and the same access to the pid namespace — deleting it from
 * `process.env` does not clear that startup memory. The image therefore keeps the token in a file
 * owned by the daemon's uid (1001) while commands run as 1000, so neither `/proc` nor the file is
 * readable from a command.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxDaemonConfig {
  const tokenFile = env.SANDBOX_TOKEN_FILE?.trim();
  let token = env.SANDBOX_TOKEN?.trim();
  if (tokenFile) token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) {
    // Fail closed: an unauthenticated files or exec API inside the sandbox would be usable by
    // anything that reaches the port.
    throw new Error(
      'SANDBOX_TOKEN_FILE or SANDBOX_TOKEN is required; refusing to start without authentication.',
    );
  }
  // Best effort for the development path only: it does not clear /proc/<pid>/environ.
  delete env.SANDBOX_TOKEN;
  delete env.SANDBOX_TOKEN_FILE;

  const port = Number(env.SANDBOX_PORT ?? 4555);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SANDBOX_PORT must be a port number between 1 and 65535.');
  }
  return {
    token,
    port,
    workspaceRoot: env.SANDBOX_WORKSPACE ?? '/workspace',
    handoffRoot: env.SANDBOX_HANDOFF ?? '/handoff',
    maxBodyBytes: Number(env.SANDBOX_MAX_BODY_BYTES ?? 64 * 1024 * 1024),
    maxTimeoutMs: Number(env.SANDBOX_MAX_TIMEOUT_MS ?? 3_600_000),
    maxOutputBytes: Number(env.SANDBOX_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024),
    ...(env.SANDBOX_COMMAND_UID && { commandUid: Number(env.SANDBOX_COMMAND_UID) }),
    ...(env.SANDBOX_COMMAND_GID && { commandGid: Number(env.SANDBOX_COMMAND_GID) }),
    commandHome: env.SANDBOX_COMMAND_HOME ?? '/home/agent',
    commandUser: env.SANDBOX_COMMAND_USER ?? 'agent',
    commandPath: env.SANDBOX_COMMAND_PATH ?? '/usr/local/bin:/usr/bin:/bin:/home/agent/.local/bin',
    setprivPath: env.SANDBOX_SETPRIV ?? '/usr/bin/setpriv',
  };
}
