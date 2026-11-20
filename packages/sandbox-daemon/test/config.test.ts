import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-config-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sandboxd config (F08, S45–S46)', () => {
  it('refuses to start without a token', () => {
    expect(() => configFromEnv({})).toThrow(/refusing to start/);
    expect(() => configFromEnv({ SANDBOX_TOKEN: '   ' })).toThrow(/refusing to start/);
  });

  it('reads the token from a file, which wins over the environment', () => {
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, 'from-the-file\n');

    const config = configFromEnv({ SANDBOX_TOKEN_FILE: file, SANDBOX_TOKEN: 'from-env' });

    expect(config.token).toBe('from-the-file');
  });

  it('removes the token variables from the environment it read (best effort)', () => {
    const env: NodeJS.ProcessEnv = { SANDBOX_TOKEN: 'secret' };
    configFromEnv(env);

    expect(env.SANDBOX_TOKEN).toBeUndefined();
  });

  it('parses the port, limits and the uid the commands drop to', () => {
    const config = configFromEnv({
      SANDBOX_TOKEN: 'secret',
      SANDBOX_PORT: '5000',
      SANDBOX_MAX_TIMEOUT_MS: '120000',
      SANDBOX_MAX_OUTPUT_BYTES: '2048',
      SANDBOX_COMMAND_UID: '1000',
      SANDBOX_COMMAND_GID: '1000',
      SANDBOX_COMMAND_HOME: '/home/agent',
    });

    expect(config).toMatchObject({
      port: 5000,
      maxTimeoutMs: 120_000,
      maxOutputBytes: 2048,
      commandUid: 1000,
      commandGid: 1000,
      commandHome: '/home/agent',
    });
  });

  it('rejects a bad port', () => {
    expect(() => configFromEnv({ SANDBOX_TOKEN: 'x', SANDBOX_PORT: 'nope' })).toThrow(/port/);
    expect(() => configFromEnv({ SANDBOX_TOKEN: 'x', SANDBOX_PORT: '70000' })).toThrow(/port/);
  });

  it('reads the egress proxy commands get, and refuses anything but an http URL', () => {
    expect(
      configFromEnv({ SANDBOX_TOKEN: 'x', SANDBOX_EGRESS_PROXY: 'http://egress-proxy:3128' })
        .commandProxy,
    ).toBe('http://egress-proxy:3128');
    expect(() =>
      configFromEnv({ SANDBOX_TOKEN: 'x', SANDBOX_EGRESS_PROXY: 'egress-proxy:3128' }),
    ).toThrow(/http/);
    expect(() =>
      configFromEnv({ SANDBOX_TOKEN: 'x', SANDBOX_EGRESS_PROXY: 'socks5://egress-proxy:1080' }),
    ).toThrow(/http/);
  });

  it('puts the persistent Python venv first on a command PATH (#102)', () => {
    const config = configFromEnv({ SANDBOX_TOKEN: 'x' });
    expect(config.commandPath.split(':')[0]).toBe('/home/agent/.venv/bin');
    expect(config.commandPath).toContain('/home/agent/.local/bin');
  });
});
