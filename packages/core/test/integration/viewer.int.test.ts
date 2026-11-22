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
import type {
  DesktopA11yTree,
  SandboxExec,
  SandboxFiles,
  DesktopCapability,
} from '../../src/ports/SandboxDriver.js';

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
let files: SandboxFiles;
let desktop: DesktopCapability;
let controlPort: string;
let viewerPort: string;
let fullViewerPort: string;
let now = Date.parse('2026-01-01T00:00:00.000Z');
let viewOnlyPassword = '';
let fullControlPassword = '';
let controlMode: 'agent' | 'owner' = 'agent';
const controlListeners = new Set<(mode: 'agent' | 'owner') => void>();
const viewerControl = {
  status: () => ({ mode: controlMode }),
  take: async () => {
    controlMode = 'owner';
    for (const listener of controlListeners) listener(controlMode);
    return { mode: controlMode };
  },
  giveBack: async () => {
    controlMode = 'agent';
    for (const listener of controlListeners) listener(controlMode);
    return { mode: controlMode };
  },
  fullCredentials: async () => driver.fullViewerCredentials(),
  onModeChange: (listener: (mode: 'agent' | 'owner') => void) => {
    controlListeners.add(listener);
    return () => controlListeners.delete(listener);
  },
};

const imageExists = (image: string): boolean =>
  spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

const freePort = async (): Promise<string> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(port);
};

const waitFor = async (
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 90_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not become ready`);
};

/** Runs an inspect-then-act step again when the window moved under the first snapshot. */
const retryOnStale = async <T>(step: () => Promise<T>, attempts = 5): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts || !/stale/.test((error as Error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
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

const wsUrl = (control?: 'full'): string =>
  `${api.url.replace('http', 'ws')}/desktop/stream${control ? `?control=${control}` : ''}`;

const upgradeStatus = (cookie?: string, control?: 'full'): Promise<number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(control), { ...(cookie && { headers: { cookie } }) });
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

const openStream = (cookie: string, control?: 'full'): Promise<{ ws: WebSocket; bytes: Bytes }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(control), { headers: { cookie } });
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

/** Closes one window by id, so a stale-ref test does not depend on where the keyboard focus is. */
const closeWindow = async (id: string): Promise<void> => {
  for await (const event of exec.run({
    program: 'wmctrl',
    args: ['-ic', id],
    cwd: '/workspace',
    timeoutMs: 10_000,
    env: { DISPLAY: ':0' },
  })) {
    if (event.type === 'exit' && event.code !== 0) {
      throw new Error(`wmctrl could not close ${id}`);
    }
  }
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
  fullViewerPort = await freePort();

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
    '-e',
    'SANDBOX_GATEWAY_FULL_VIEWER_PORT=6080',
    '-e',
    'SANDBOX_GATEWAY_FULL_VIEWER_TARGET=sandbox:6080',
    '-p',
    `127.0.0.1:${controlPort}:4555`,
    '-p',
    `127.0.0.1:${viewerPort}:6081`,
    '-p',
    `127.0.0.1:${fullViewerPort}:6080`,
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
  files = opened.files!;
  desktop = opened.desktop!;
  viewOnlyPassword = (await driver.viewerCredentials()).viewOnlyPassword;
  fullControlPassword = (await driver.fullViewerCredentials()).fullControlPassword;

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
        stream: {
          viewOnly: { host: '127.0.0.1', port: Number(viewerPort) },
          full: { host: '127.0.0.1', port: Number(fullViewerPort) },
        },
        control: viewerControl,
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
      const body = (await credentials.json()) as {
        viewOnlyPassword: string;
        mode: string;
        fullControlPassword?: string;
      };
      expect(body.viewOnlyPassword).toBe(viewOnlyPassword);
      expect(body.mode).toBe('agent');
      expect(body.fullControlPassword).toBeUndefined();

      const passwordFile = JSON.parse(
        docker(['exec', '-u', '1001:1000', sandbox, 'cat', '/run/sandbox/vnc-passwords.json']),
      ) as { viewOnly: string; full: string };
      expect(body.viewOnlyPassword).toBe(passwordFile.viewOnly);
      expect(body.viewOnlyPassword).not.toBe(passwordFile.full);
    },
  );

  it.runIf(available)(
    'takes control, relays full input and closes every full stream on Give back (S55)',
    async () => {
      now = Date.parse('2026-01-01T00:00:00.000Z');
      const cookie = await signIn();
      const before = await pointer();
      await expect(upgradeStatus(cookie, 'full')).resolves.toBe(403);

      const take = await fetch(`${api.url}/desktop/take`, {
        method: 'POST',
        headers: { cookie, origin: api.url },
      });
      expect(take.status).toBe(200);
      expect(await take.json()).toMatchObject({ mode: 'owner' });

      const credentials = await fetch(`${api.url}/desktop/credentials`, {
        headers: { cookie },
      });
      const body = (await credentials.json()) as {
        mode: string;
        fullControlPassword?: string;
      };
      expect(body.mode).toBe('owner');
      expect(body.fullControlPassword).toBe(fullControlPassword);

      const { ws, bytes } = await openStream(cookie, 'full');
      await rfbAuth(ws, bytes, fullControlPassword);
      const target = { x: (before.x + 40) % 1400, y: (before.y + 30) % 860 };
      const event = Buffer.alloc(6);
      event[0] = 5;
      event[1] = 0;
      event.writeUInt16BE(target.x, 2);
      event.writeUInt16BE(target.y, 4);
      send(ws, event);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await pointer()).toEqual(target);

      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      const give = await fetch(`${api.url}/desktop/give-back`, {
        method: 'POST',
        headers: { cookie, origin: api.url },
      });
      expect(give.status).toBe(200);
      expect(await give.json()).toMatchObject({ mode: 'agent' });
      expect(await closed).toBe(1000);

      await expect(upgradeStatus(cookie, 'full')).resolves.toBe(403);
      const after = await fetch(`${api.url}/desktop/credentials`, { headers: { cookie } });
      const afterBody = (await after.json()) as {
        mode: string;
        fullControlPassword?: string;
      };
      expect(afterBody.mode).toBe('agent');
      expect(afterBody.fullControlPassword).toBeUndefined();
    },
    60_000,
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

describe('desktop computer use (S53)', () => {
  it.runIf(available)(
    'launches Thunar, clicks, types a path and sees it in OCR',
    async () => {
      const folder = 's53-folder';
      await files.mkdir(await files.resolve(folder));
      const signal = AbortSignal.timeout(20_000);

      await desktop.act({ kind: 'launch_app', app: 'thunar' }, signal);
      let thunar: { x: number; y: number } | undefined;
      await waitFor(async () => {
        const windows = await desktop.windows(signal);
        const found = windows.find((window) => /thunar|file manager/i.test(window.title));
        if (found) {
          thunar = { x: found.x, y: found.y };
          return true;
        }
        return false;
      }, 'the Thunar window');

      await desktop.act({ kind: 'click', x: thunar!.x + 80, y: thunar!.y + 20 }, signal);
      await desktop.act({ kind: 'key', key: 'ctrl+l' }, signal);
      await desktop.act({ kind: 'type', text: `/workspace/${folder}` }, signal);
      await desktop.act({ kind: 'key', key: 'Return' }, signal);

      await waitFor(async () => {
        const windows = await desktop.windows(signal);
        return windows.some((window) => window.title.toLowerCase().includes(folder));
      }, 'the Thunar title to show the folder');

      const shot = await desktop.screenshot({}, signal);
      expect(shot.mediaType).toBe('image/png');
      expect(shot.data.length).toBeGreaterThan(0);
      const full = await desktop.screenshot({ scale: 1 }, signal);
      expect(full).toMatchObject({
        width: shot.originalWidth,
        height: shot.originalHeight,
        scale: 1,
      });
      expect(full.data.length).toBeGreaterThan(0);
      const ocr = await desktop.ocr({}, signal);
      expect(ocr.text.toLowerCase()).toContain(folder);
    },
    60_000,
  );
});

describe('desktop accessibility (S54)', () => {
  it.runIf(available)(
    'reads named elements from Thunar, the terminal and Chromium',
    async () => {
      expect(desktop.accessibility).toBe(true);
      const signal = AbortSignal.timeout(60_000);
      const windows = [
        { app: 'thunar', window: /thunar|file manager/i },
        { app: 'xfce4-terminal', window: /terminal|xfce4|@/i },
        { app: 'chromium', window: /chrom|new tab/i },
      ] as const;
      for (const item of windows) {
        await desktop.act({ kind: 'launch_app', app: item.app }, signal);
        await waitFor(async () => {
          const list = await desktop.windows(signal);
          return list.some((window) => item.window.test(window.title));
        }, `the ${item.app} window`);

        let tree: DesktopA11yTree | undefined;
        await waitFor(async () => {
          try {
            tree = await desktop.inspect(
              { window: item.app === 'xfce4-terminal' ? 'terminal' : item.app, depth: 8 },
              signal,
            );
          } catch {
            return false;
          }
          return tree.nodes.some((node) => node.depth > 0 && Boolean(node.name));
        }, `a named ${item.app} tree`);
        expect(tree!.snapshot).toMatch(/^s\d+$/);
        expect(tree!.nodes.length).toBeGreaterThan(0);
        expect(tree!.nodes.every((node) => /^e\d+$/.test(node.ref))).toBe(true);
        expect(tree!.nodes.some((node) => node.depth > 0 && Boolean(node.name))).toBe(true);
      }
    },
    240_000,
  );

  it.runIf(available)(
    'refuses a ref from a stale snapshot',
    async () => {
      const signal = AbortSignal.timeout(30_000);
      await desktop.act({ kind: 'launch_app', app: 'thunar' }, signal);
      await waitFor(async () => {
        const list = await desktop.windows(signal);
        return list.some((window) => /thunar|file manager/i.test(window.title));
      }, 'the Thunar window');
      const tree = await desktop.inspect({ window: 'thunar', depth: 6 }, signal);
      await expect(
        desktop.actOnElement({ snapshot: tree.snapshot, ref: 'e9999', action: 'click' }, signal),
      ).rejects.toThrow(/stale/);
    },
    90_000,
  );

  it.runIf(available)(
    'sets text, clicks a menu and refuses the old snapshot after the window changed',
    async () => {
      const signal = AbortSignal.timeout(60_000);
      await desktop.act({ kind: 'launch_app', app: 'thunar' }, signal);
      await waitFor(async () => {
        const list = await desktop.windows(signal);
        return list.some((window) => /thunar|file manager/i.test(window.title));
      }, 'the Thunar window');

      // set_text replaces the location field; Return navigates. A snapshot can go stale while
      // Thunar is still settling, so a real caller retries with a fresh one.
      await retryOnStale(async () => {
        const before = await desktop.inspect({ window: 'thunar', depth: 8 }, signal);
        const field = before.nodes.find(
          (node) => node.role === 'text' && node.states.includes('editable'),
        );
        if (!field) throw new Error('Thunar has no editable location field');
        await desktop.actOnElement(
          { snapshot: before.snapshot, ref: field.ref, action: 'set_text', text: '/workspace' },
          signal,
        );
      });
      await desktop.act({ kind: 'key', key: 'Return' }, signal);

      let navigated: DesktopA11yTree | undefined;
      await waitFor(async () => {
        try {
          navigated = await desktop.inspect({ window: 'thunar', depth: 8 }, signal);
        } catch {
          return false;
        }
        return navigated.nodes.some((node) => node.value?.includes('/workspace'));
      }, 'the location field to show /workspace');

      const clicked = await retryOnStale(async () => {
        const tree = await desktop.inspect({ window: 'thunar', depth: 8 }, signal);
        const menu = tree.nodes.find((node) => node.role === 'menu' && node.name === 'File');
        if (!menu) throw new Error('Thunar has no File menu');
        await desktop.actOnElement(
          { snapshot: tree.snapshot, ref: menu.ref, action: 'click' },
          signal,
        );
        return { tree, menu };
      });
      await desktop.act({ kind: 'key', key: 'Escape' }, signal);

      const thunarWindow = (await desktop.windows(signal)).find((window) =>
        /thunar|file manager/i.test(window.title),
      );
      expect(thunarWindow).toBeDefined();
      await closeWindow(thunarWindow!.id);
      await waitFor(
        async () => {
          const list = await desktop.windows(signal);
          return !list.some((window) => window.id === thunarWindow!.id);
        },
        'the Thunar window to close',
        10_000,
      );

      // The window that held this snapshot is gone; its refs must be refused, not clicked blindly.
      await expect(
        desktop.actOnElement(
          { snapshot: clicked.tree.snapshot, ref: clicked.menu.ref, action: 'click' },
          signal,
        ),
      ).rejects.toThrow(/stale/);
    },
    90_000,
  );
});

describe('desktop Calc end to end (S56)', () => {
  it.runIf(available)(
    'opens Calc, types numbers, saves /workspace/calc.csv and reads it back with workspace.exec',
    async () => {
      const signal = AbortSignal.timeout(180_000);
      const findOne = async (
        window: string,
        query: { name?: string; role?: string },
        match: (node: { name?: string; role: string; value?: string }) => boolean,
      ) => {
        let found: { tree: DesktopA11yTree; ref: string } | undefined;
        await waitFor(
          async () => {
            try {
              const tree = await desktop.find(
                {
                  window,
                  ...(query.name && { name: query.name }),
                  ...(query.role && { role: query.role }),
                },
                signal,
              );
              const node = tree.nodes.find(match);
              if (node) found = { tree, ref: node.ref };
              return Boolean(node);
            } catch {
              return false;
            }
          },
          `${query.name ?? query.role ?? 'the element'} in ${window}`,
          20_000,
        );
        return found!;
      };

      await desktop.act({ kind: 'launch_app', app: 'libreoffice' }, signal);
      await waitFor(async () => {
        const list = await desktop.windows(signal);
        return list.some((window) => /libreoffice/i.test(window.title));
      }, 'the LibreOffice window');

      const calc = await findOne(
        'LibreOffice',
        { name: 'Calc Spreadsheet' },
        (node) => node.name === 'Calc Spreadsheet',
      );
      await desktop.actOnElement(
        { snapshot: calc.tree.snapshot, ref: calc.ref, action: 'click' },
        signal,
      );
      await waitFor(async () => {
        const list = await desktop.windows(signal);
        return list.some((window) => /LibreOffice Calc/i.test(window.title));
      }, 'the Calc window');

      // The Tip of the Day dialog appears once; close it if it is there.
      try {
        const tip = await findOne('Tip', { name: 'OK' }, (node) => node.name === 'OK');
        await desktop.actOnElement(
          { snapshot: tip.tree.snapshot, ref: tip.ref, action: 'click' },
          signal,
        );
      } catch {
        // A later run may not show it.
      }

      for (const [cell, value] of [
        ['A1', '42'],
        ['B1', '7'],
      ] as const) {
        const target = await findOne('Calc', { name: cell }, (node) => node.name === cell);
        await desktop.actOnElement(
          { snapshot: target.tree.snapshot, ref: target.ref, action: 'click' },
          signal,
        );
        await desktop.act({ kind: 'type', text: value }, signal);
        await desktop.act({ kind: 'key', key: 'Return' }, signal);
      }
      await desktop.act({ kind: 'key', key: 'ctrl+s' }, signal);

      await waitFor(async () => {
        const list = await desktop.windows(signal);
        return list.some((window) => /^Save$|Save As|Confirm File Format/i.test(window.title));
      }, 'the Save dialog');

      const nameField = await findOne(
        'soffice',
        { role: 'text' },
        (node) => node.value === 'Untitled 1' || node.value === 'Untitled 1.csv',
      );
      await desktop.actOnElement(
        {
          snapshot: nameField.tree.snapshot,
          ref: nameField.ref,
          action: 'set_text',
          text: '/workspace/calc.csv',
        },
        signal,
      );
      const saveButton = await findOne(
        'soffice',
        { role: 'push button' },
        (node) => node.name === 'Save',
      );
      await desktop.actOnElement(
        { snapshot: saveButton.tree.snapshot, ref: saveButton.ref, action: 'click' },
        signal,
      );

      const csvButton = await findOne(
        'soffice',
        { name: 'Use Text CSV' },
        (node) => node.name === 'Use Text CSV Format',
      );
      await desktop.actOnElement(
        { snapshot: csvButton.tree.snapshot, ref: csvButton.ref, action: 'click' },
        signal,
      );

      await retryOnStale(async () => {
        const exportOk = await findOne('soffice', { name: 'OK' }, (node) => node.name === 'OK');
        await desktop.actOnElement(
          { snapshot: exportOk.tree.snapshot, ref: exportOk.ref, action: 'click' },
          signal,
        );
      });

      let content = '';
      await waitFor(
        async () => {
          content = '';
          for await (const event of exec.run({
            program: 'cat',
            args: ['calc.csv'],
            cwd: '/workspace',
            timeoutMs: 10_000,
          })) {
            if (event.type === 'stdout') content += event.text;
          }
          return content.includes('42') && content.includes('7');
        },
        'the saved calc.csv',
        20_000,
      );
      expect(content).toMatch(/42.*7|7.*42/s);
    },
    240_000,
  );
});
