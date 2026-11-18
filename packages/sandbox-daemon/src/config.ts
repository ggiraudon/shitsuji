/** Where sandboxd finds its settings. The token is the only secret and is never logged. */
export interface SandboxDaemonConfig {
  token: string;
  port: number;
  workspaceRoot: string;
  handoffRoot: string;
  /** The largest request body; a base64 write of a 48 MB file fits. */
  maxBodyBytes: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxDaemonConfig {
  const token = env.SANDBOX_TOKEN?.trim();
  if (!token) {
    // Fail closed: an unauthenticated files API inside the sandbox would be usable by anything that
    // reaches the port.
    throw new Error('SANDBOX_TOKEN is required; refusing to start without authentication.');
  }
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
  };
}
