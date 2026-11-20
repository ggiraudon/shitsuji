import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { ShitsujiSandboxDriver } from '../../src/adapters/sandbox/shitsuji/ShitsujiSandboxDriver.js';
import { startApiServer, type RunningApi } from '../../src/composition/apiServer.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import type { ApiDeps } from '../../src/interfaces/http/createApi.js';
import type { SandboxExec } from '../../src/ports/SandboxDriver.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SANDBOX_IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'shitsuji/sandbox-desktop:integration';
const OWNER = asId<OwnerId>('owner');
const KEY = 'owner-key';
const docker = (args: string[], input?: string): string =>
  execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', input, stdio: 'pipe' });
const clean = (args: string[]): void => {
  try {
    docker(args);
  } catch {
    // Best effort: the test is already failing or the container is gone.
  }
};
const available = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const suffix = randomBytes(4).toString('hex');
const network = `shitsuji-s51-${suffix}`;
const ctl = `${network}-ctl`;
const sandbox = `shitsuji-s51-sandbox-${suffix}`;
const gateway = `shitsuji-s51-gateway-${suffix}`;
const workspaceVolume = `shitsuji-s51-workspace-${suffix}`;
const handoffVolume = `shitsuji-s51-handoff-${suffix}`;
const homeVolume = `shitsuji-s51-home-${suffix}`;
const token = randomBytes(32).toString('hex');

let api: RunningApi;
let driver: ShitsujiSandboxDriver;
let exec: SandboxExec;
let controlPort: string;
let viewerPort: string;
let now = Date.parse('2026-01-01T00:00:00.000Z');
let viewOnlyPassword = '';

const imageExists = (image: string): boolean =>
  spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

const freePort = async (): Promise<string> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(port);
};

const waitFor = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not become ready`);
};

const signIn = async (): Promise<string> => {
  const response = await fetch(`${api.url}/desktop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `key=${KEY}`,
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  return response.headers.getSetCookie()[0]!.split(';')[0]!;
};

const wsUrl = (): string => `${api.url.replace('http', 'ws')}/desktop/stream`;

const upgradeStatus = (cookie?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { ...(cookie && { headers: { cookie } }) });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('the upgrade should have been refused'));
    });
    ws.on('error', () => undefined);
  });

const openStream = (cookie: string): Promise<{ ws: WebSocket; bytes: Bytes }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { headers: { cookie } });
    const bytes = new Bytes(ws);
    ws.once('open', () => resolve({ ws, bytes }));
    ws.once('error', reject);
  });

/** A tiny byte stream over WebSocket frames (websockify is a WebSocket server, not raw TCP). */
class Bytes {
  private buffer = Buffer.alloc(0);
  private waiting: { length: number; resolve: (value: Buffer) => void }[] = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(data as Buffer)]);
      this.flush();
    });
  }

  read(length: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiting.push({ length, resolve });
      this.flush();
    });
  }

  private flush(): void {
    for (;;) {
      const first = this.waiting[0];
      if (!first || this.buffer.length < first.length) return;
      const value = this.buffer.subarray(0, first.length);
      this.buffer = this.buffer.subarray(first.length);
      this.waiting.shift();
      first.resolve(value);
    }
  }
}

const send = (ws: WebSocket, bytes: Buffer): void => ws.send(bytes);

/** VNC authentication, using the DES implementation noVNC itself ships. */
async function rfbAuth(ws: WebSocket, bytes: Bytes, password: string): Promise<void> {
  const version = await bytes.read(12);
  expect(version.toString()).toBe('RFB 003.008\n');
  send(ws, Buffer.from('RFB 003.008\n'));

  const count = (await bytes.read(1))[0]!;
  const types = await bytes.read(count);
  expect([...types]).toContain(2);
  send(ws, Buffer.from([2]));

  const challenge = await bytes.read(16);
  const require = createRequire(import.meta.url);
  const desPath = path.join(path.dirname(require.resolve('@novnc/novnc')), 'crypto/des.js');
  const { DESECBCipher } = (await import(pathToFileURL(desPath).href)) as {
    DESECBCipher: {
      importKey: (
        key: number[],
        algorithm: { name: string },
        extractable: boolean,
        usages: string[],
      ) => { encrypt(algorithm: { name: string }, plaintext: Uint8Array): Uint8Array };
    };
  };
  const key = [...password].map((ch) => ch.charCodeAt(0));
  const cipher = DESECBCipher.importKey(key, { name: 'DES-ECB' }, false, ['encrypt']);
  send(ws, Buffer.from(cipher.encrypt({ name: 'DES-ECB' }, new Uint8Array(challenge))));

  const security = await bytes.read(4);
  expect(security.readUInt32BE(0)).toBe(0);
  send(ws, Buffer.from([1])); // shared

  const serverInit = await bytes.read(24);
  const nameLength = serverInit.readUInt32BE(20);
  await bytes.read(nameLength);
}

const pointer = async (): Promise<{ x: number; y: number }> => {
  let out = '';
  for await (const event of exec.run({
    program: 'xdotool',
    args: ['getmouselocation'],
    cwd: '/workspace',
    timeoutMs: 10_000,
    env: { DISPLAY: ':0' },
  })) {
    if (event.type === 'stdout') out += event.text;
  }
  const match = /x:(\d+)\s+y:(\d+)/.exec(out);
  if (!match) throw new Error(`xdotool said: ${out}`);
  return { x: Number(match[1]), y: Number(match[2]) };
};

beforeAll(async () => {
  if (!available) return;
  if (!imageExists(SANDBOX_IMAGE)) {
    if (!imageExists('shitsuji/sandbox')) {
      docker(['build', '-f', 'docker/sandbox/Dockerfile', '-t', 'shitsuji/sandbox', '.']);
    }
    docker(['build', '-f', 'docker/sandbox-desktop/Dockerfile', '-t', SANDBOX_IMAGE, '.']);
  }

  docker(['network', 'create', '--internal', network]);
  docker(['network', 'create', ctl]);
  for (const volume of [workspaceVolume, handoffVolume, homeVolume]) {
    docker(['volume', 'create', volume]);
  }
  controlPort = await freePort();
  viewerPort = await freePort();

  docker([
    'run',
    '-d',
    '--name',
    sandbox,
    '--init',
    '--pids-limit',
    '512',
    '--shm-size',
    '1g',
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
    `${workspaceVolume}:/workspace`,
    '--mount',
    `source=${handoffVolume},target=/handoff,readonly`,
    '-v',
    `${homeVolume}:/home/agent`,
    '-e',
    `SANDBOX_TOKEN=${token}`,
    SANDBOX_IMAGE,
  ]);

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
    'SANDBOX_GATEWAY_PORT=4555',
    '-e',
    'SANDBOX_GATEWAY_TARGET=sandbox:4555',
    '-e',
    'SANDBOX_GATEWAY_VIEWER_PORT=6081',
    '-e',
    'SANDBOX_GATEWAY_VIEWER_TARGET=sandbox:6081',
    '-p',
    `127.0.0.1:${controlPort}:4555`,
    '-p',
    `127.0.0.1:${viewerPort}:6081`,
    '--entrypoint',
    'node',
    SANDBOX_IMAGE,
    '/app/dist/gateway-main.js',
  ]);
  docker(['network', 'connect', network, gateway]);

  await waitFor(
    async () =>
      (await fetch(`http://127.0.0.1:${controlPort}/health`).catch(() => undefined))?.ok === true,
    'the desktop sandbox',
  );

  driver = new ShitsujiSandboxDriver({
    baseUrl: `http://127.0.0.1:${controlPort}`,
    token,
    log: new MemoryLogger(),
  });
  const opened = await driver.open({ ownerId: OWNER });
  exec = opened.exec!;
  viewOnlyPassword = (await driver.viewerCredentials()).viewOnlyPassword;

  api = await startApiServer(
    {
      agent: {},
      repos: {},
      events: {},
      clock: { now: () => new Date(now) },
      log: new MemoryLogger(),
      ownerId: OWNER,
      soul: {},
      pairing: {},
      approvals: {},
      verifyKey: (key: string | undefined) => key === KEY,
      viewer: {
        credentials: () => driver.viewerCredentials(),
        stream: { host: '127.0.0.1', port: Number(viewerPort) },
        cookieSecure: false,
      },
    } as unknown as Omit<ApiDeps, 'webSocket'>,
    { listen: '127.0.0.1', port: 0 },
  );
}, 300_000);

afterAll(async () => {
  if (!available) return;
  await api?.close();
  clean(['rm', '-f', sandbox, gateway]);
  clean(['network', 'rm', network, ctl]);
  for (const volume of [workspaceVolume, handoffVolume, homeVolume]) {
    clean(['volume', 'rm', volume]);
  }
});

describe('desktop viewer (S51)', () => {
  it.runIf(available)('refuses the page, credentials and stream before sign-in', async () => {
    expect((await fetch(`${api.url}/desktop`)).status).toBe(401);
    expect((await fetch(`${api.url}/desktop/credentials`)).status).toBe(401);
    await expect(upgradeStatus()).resolves.toBe(401);
  });

  it.runIf(available)(
    'exchanges the key for a cookie and serves the real view-only password',
    async () => {
      const cookie = await signIn();
      const page = await fetch(`${api.url}/desktop`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('/desktop/viewer.js');

      const credentials = await fetch(`${api.url}/desktop/credentials`, { headers: { cookie } });
      expect(credentials.status).toBe(200);
      const body = (await credentials.json()) as { viewOnlyPassword: string };
      expect(body.viewOnlyPassword).toBe(viewOnlyPassword);

      const passwordFile = JSON.parse(
        docker(['exec', '-u', '1001:1000', sandbox, 'cat', '/run/sandbox/vnc-passwords.json']),
      ) as { viewOnly: string; full: string };
      expect(body.viewOnlyPassword).toBe(passwordFile.viewOnly);
      expect(body.viewOnlyPassword).not.toBe(passwordFile.full);
    },
  );

  it.runIf(available)('refuses an expired cookie', async () => {
    const cookie = await signIn();
    now += 60 * 60 * 1000 + 1;
    expect((await fetch(`${api.url}/desktop`, { headers: { cookie } })).status).toBe(401);
    await expect(upgradeStatus(cookie)).resolves.toBe(401);
  });

  it.runIf(available)('relays the RFB banner from the view-only websockify stream', async () => {
    now = Date.parse('2026-01-01T00:00:00.000Z');
    const cookie = await signIn();
    const { ws, bytes } = await openStream(cookie);
    const banner = await bytes.read(12);
    expect(banner.toString()).toBe('RFB 003.008\n');
    ws.close();
  });

  it.runIf(available)('ignores pointer input on the view-only stream', async () => {
    now = Date.parse('2026-01-01T00:00:00.000Z');
    const cookie = await signIn();
    const before = await pointer();
    const { ws, bytes } = await openStream(cookie);
    await rfbAuth(ws, bytes, viewOnlyPassword);

    const target = { x: (before.x + 72) % 1400, y: (before.y + 48) % 860 };
    const event = Buffer.alloc(6);
    event[0] = 5;
    event[1] = 0;
    event.writeUInt16BE(target.x, 2);
    event.writeUInt16BE(target.y, 4);
    send(ws, event);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await pointer();
    expect(after).toEqual(before);
    ws.close();
  });
});
