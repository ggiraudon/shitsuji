import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { ShitsujiSandboxDriver } from '../../src/adapters/sandbox/shitsuji/ShitsujiSandboxDriver.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { describeSandboxContract } from '../contracts/sandbox.contract.js';

/**
 * The shitsuji driver against the real sandbox and egress-proxy images (F08, S48): the contract
 * suite, the egress probes, the proxy command environment and a refused private address. Without
 * Docker the suite is skipped, so `pnpm check` stays offline.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SANDBOX_IMAGE = 'shitsuji/sandbox:integration';
const EGRESS_IMAGE = 'shitsuji/egress:integration';
const docker = (args: string[], input?: string): string =>
  execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', input, stdio: 'pipe' });

const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 }).status === 0;

interface Containers {
  sandbox: string;
  proxy: string;
  gateway: string;
  network: string;
  ctl: string;
  secretVolume: string;
  dir: string;
  baseUrl: string;
  token: string;
}

if (!dockerAvailable) {
  describe.skip('shitsuji sandbox against real containers (F08, S48)', () => {
    it('needs Docker', () => undefined);
  });
} else {
  const containers = await start();

  afterAll(() => {
    for (const name of [containers.gateway, containers.proxy, containers.sandbox]) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
    for (const network of [containers.ctl, containers.network]) {
      spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
    }
    spawnSync('docker', ['volume', 'rm', containers.secretVolume], { stdio: 'ignore' });
    fs.rmSync(containers.dir, { recursive: true, force: true });
  });

  const driver = new ShitsujiSandboxDriver({
    baseUrl: containers.baseUrl,
    token: containers.token,
    log: new MemoryLogger(),
  });

  await describeSandboxContract({
    name: 'shitsuji',
    driver,
    processContainment: true,
  });

  describe('shitsuji egress through egress-proxy (F08, S48)', () => {
    it('cannot reach the LAN or a name core would answer, and commands carry the proxy', async () => {
      const sandbox = await driver.open({ ownerId: asId<OwnerId>('owner') });
      try {
        expect(await sandbox.egress!.reachable('192.168.1.1', 80, 1_000)).toBe(false);
        expect(await sandbox.egress!.reachable('core', 3001, 500)).toBe(false);
        expect(await sandbox.egress!.reachable('postgres', 5432, 500)).toBe(false);

        const result = await run(sandbox, [
          'sh',
          '-c',
          'printf "http=%s https=%s\\n" "$HTTP_PROXY" "$HTTPS_PROXY"; ' +
            'printf "no=%s\\n" "$NO_PROXY"; ' +
            'curl -s -o /dev/null -w "%{http_code}" -x "$HTTP_PROXY" http://192.168.1.1/',
        ]);
        expect(result.stdout).toContain('http=http://egress-proxy:3128');
        expect(result.stdout).toContain('https=http://egress-proxy:3128');
        expect(result.stdout).toContain('no=127.0.0.1,localhost,::1');
        expect(result.stdout).toContain('403');
      } finally {
        await sandbox.close();
      }
    });
  });

  describe('the token is out of a command’s reach (F08, S48)', () => {
    it('cannot be read, found or grepped by uid 1000', async () => {
      const sandbox = await driver.open({ ownerId: asId<OwnerId>('owner') });
      try {
        const result = await run(sandbox, [
          'sh',
          '-c',
          'cat /run/sandbox-seed/token 2>&1; ' +
            'ls /run/sandbox-seed 2>&1; ' +
            'cat /run/sandbox/token 2>&1; ' +
            'echo "env=$(env | grep -ci token)"; ' +
            "echo \"find=$(find / -xdev -name '*token*' -readable 2>/dev/null | grep -c -E 'sandbox|seed')\"",
        ]);
        expect(result.stdout.match(/Permission denied/g)).toHaveLength(3);
        expect(result.stdout).toContain('env=0');
        expect(result.stdout).toContain('find=0');
        expect(result.stdout).not.toContain(containers.token);

        // The token value itself must not be in any readable file; the value comes through the
        // command's environment so it never appears in its argv.
        const grep = await run(
          sandbox,
          [
            'sh',
            '-c',
            'grep -rl "$TEST_TOKEN" /etc /home /workspace /tmp /app /usr /opt /var /run 2>/dev/null | wc -l',
          ],
          { TEST_TOKEN: containers.token },
        );
        expect(grep.stdout.trim()).toBe('0');
        expect(grep.stdout).not.toContain(containers.token);

        // The seed directory is the protection; check it as root, which owns it.
        const stat = spawnSync(
          'docker',
          [
            'exec',
            containers.sandbox,
            'sh',
            '-c',
            'ls -ld /run/sandbox-seed; ls -l /run/sandbox-seed/token',
          ],
          { encoding: 'utf8' },
        );
        expect(stat.stdout).toMatch(/^drwxrwx---\s+\d+\s+root\s+1002\s+.*\/run\/sandbox-seed$/m);
        expect(stat.stdout).toContain('-rw-r--r--');
        // Root (the directory's owner, with no DAC_OVERRIDE) can still read the seed; that is how
        // the entrypoint installed it.
        const seed = spawnSync(
          'docker',
          ['exec', containers.sandbox, 'cat', '/run/sandbox-seed/token'],
          {
            encoding: 'utf8',
          },
        );
        expect(seed.stdout).toBe(containers.token);
      } finally {
        await sandbox.close();
      }
    });
  });
}

async function run(
  sandbox: Awaited<ReturnType<ShitsujiSandboxDriver['open']>>,
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  let events = 0;
  for await (const event of sandbox.exec!.run({
    program: argv[0]!,
    args: argv.slice(1),
    env,
    cwd: await sandbox.files!.resolve('.'),
    timeoutMs: 30_000,
  })) {
    if (event.type === 'stdout') out.push(event.text);
    else if (event.type === 'stderr') err.push(event.text);
    else if (event.type === 'exit' && event.code !== 0) events = event.code ?? 1;
  }
  return { stdout: out.join(''), stderr: err.join('') || String(events) };
}

/** Builds the images if needed and starts the proxy and the sandbox on a private network. */
async function start(): Promise<Containers> {
  for (const [image, dockerfile] of [
    [SANDBOX_IMAGE, 'docker/sandbox/Dockerfile'],
    [EGRESS_IMAGE, 'docker/egress-proxy/Dockerfile'],
  ] as const) {
    if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
      docker(['build', '-f', dockerfile, '-t', image, '.']);
    }
  }

  const network = `shitsuji-s48-${randomBytes(4).toString('hex')}`;
  const ctl = `${network}-ctl`;
  docker(['network', 'create', '--internal', network]);
  docker(['network', 'create', ctl]);
  const suffix = randomBytes(4).toString('hex');
  const proxy = `shitsuji-egress-${suffix}`;
  const sandbox = `shitsuji-sandbox-${suffix}`;
  const gateway = `shitsuji-gateway-${suffix}`;
  const secretVolume = `shitsuji-secret-${suffix}`;

  try {
    docker([
      'run',
      '-d',
      '--name',
      proxy,
      '--network',
      network,
      '--network-alias',
      'egress-proxy',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-e',
      'SANDBOX_EGRESS_ALLOW=example.com',
      EGRESS_IMAGE,
    ]);
    await waitFor(
      () =>
        spawnSync(
          'docker',
          [
            'exec',
            proxy,
            'node',
            '-e',
            "fetch('http://127.0.0.1:3128/health').then(()=>process.exit(0),()=>process.exit(1))",
          ],
          { stdio: 'ignore' },
        ).status === 0,
      'egress-proxy',
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-sandbox-it-'));
    fs.mkdirSync(path.join(dir, 'workspace'));
    fs.mkdirSync(path.join(dir, 'handoff'));
    const token = randomBytes(32).toString('hex');
    const port = String(await freePort());

    // The production path: core writes a token into the secret volume, whose directory is
    // root:1002 0770; commands (uid/gid 1000) cannot traverse it.
    docker(['volume', 'create', secretVolume]);
    docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--cap-add',
      'FOWNER',
      '--entrypoint',
      'sh',
      '-v',
      `${secretVolume}:/secret`,
      SANDBOX_IMAGE,
      '-c',
      'chown 0:1002 /secret && chmod 0770 /secret',
    ]);
    docker([
      'run',
      '--rm',
      '--user',
      '1000:1000',
      '--group-add',
      '1002',
      '--entrypoint',
      'sh',
      '-v',
      `${secretVolume}:/secret`,
      SANDBOX_IMAGE,
      '-c',
      `printf %s ${token} > /secret/token && chmod 0644 /secret/token`,
    ]);

    docker([
      'run',
      '-d',
      '--name',
      sandbox,
      '--init',
      '--pids-limit',
      '256',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--cap-add',
      'FOWNER',
      '--cap-add',
      'SETUID',
      '--cap-add',
      'SETGID',
      '--cap-add',
      'SETPCAP',
      '--cap-add',
      'KILL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      network,
      '--network-alias',
      'sandbox',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/run/sandbox',
      '-v',
      `${path.join(dir, 'workspace')}:/workspace`,
      '-v',
      `${path.join(dir, 'handoff')}:/handoff:ro`,
      '--mount',
      `source=${secretVolume},target=/run/sandbox-seed,readonly`,
      '-e',
      'SANDBOX_EGRESS_PROXY=http://egress-proxy:3128',
      SANDBOX_IMAGE,
    ]);

    // The host cannot publish a port from an internal network, so the control port comes through
    // the same relay Compose uses: it is the only path into the sandbox network.
    docker([
      'run',
      '-d',
      '--name',
      gateway,
      '--network',
      ctl,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-e',
      'SANDBOX_GATEWAY_TARGET=sandbox:4555',
      '-p',
      `127.0.0.1:${port}:4555`,
      '--entrypoint',
      'node',
      SANDBOX_IMAGE,
      '/app/dist/gateway-main.js',
    ]);
    docker(['network', 'connect', network, gateway]);

    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      return response?.ok === true;
    }, gateway);

    return {
      sandbox,
      proxy,
      gateway,
      network,
      ctl,
      secretVolume,
      dir,
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    };
  } catch (error) {
    // Do not leave half a run behind for the next attempt.
    for (const name of [gateway, sandbox, proxy]) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
    for (const name of [ctl, network]) {
      spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
    }
    spawnSync('docker', ['volume', 'rm', secretVolume], { stdio: 'ignore' });
    throw error;
  }
}

/** An unused host port; Docker publishes it to the sandbox's 4555. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** Polls a check for up to 90 s, then reports the container's log (never the token). */
async function waitFor(check: () => boolean | Promise<boolean>, name: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  throw new Error(`${name} did not become healthy:\n${logs.stdout}${logs.stderr}`);
}
