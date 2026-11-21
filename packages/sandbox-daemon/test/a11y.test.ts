import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { A11yService } from '../src/a11y.js';

const fixture = fileURLToPath(new URL('./fixtures/a11y-helper.mjs', import.meta.url));

interface Made {
  service: A11yService;
  log: string[];
  ops: () => Promise<string[]>;
  dir: string;
}

const made: Made[] = [];

async function make(
  options: { mode?: string; timeoutMs?: number; maxLineBytes?: number; marker?: boolean } = {},
): Promise<Made> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-'));
  const logFile = path.join(dir, 'ops.log');
  const marker = path.join(dir, 'marker');
  if (options.marker) await fs.writeFile(marker, '1');
  const log: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.A11Y_FIXTURE_MODE = options.mode ?? 'normal';
  env.A11Y_FIXTURE_LOG = logFile;
  env.A11Y_FIXTURE_MARKER = marker;
  const service = new A11yService({
    command: [process.execPath, fixture],
    env,
    timeoutMs: options.timeoutMs ?? 2_000,
    maxLineBytes: options.maxLineBytes ?? 64 * 1024,
    log: (level, message) => log.push(`${level}: ${message}`),
  });
  const entry: Made = {
    service,
    log,
    dir,
    ops: async () => {
      const text = await fs.readFile(logFile, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
  };
  made.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of made.splice(0)) {
    entry.service.stop();
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('sandboxd AT-SPI helper client (S54)', () => {
  it('returns a validated tree and maps the allowed apps for the startup check', async () => {
    const { service, log } = await make();
    await expect(service.start()).resolves.toBe(true);
    const status = await service.status();
    expect(status.helper).toBe(true);
    expect(status.apps.find((entry) => entry.app === 'thunar')).toMatchObject({
      tree: true,
      nodes: 4,
    });
    expect(status.apps.find((entry) => entry.app === 'chromium')).toMatchObject({ tree: true });
    expect(status.missing).toEqual(['libreoffice', 'xfce4-terminal']);

    const tree = await service.tree({ window: 'Thunar', depth: 3 });
    expect(tree).toMatchObject({
      app: 'thunar',
      snapshot: 's1',
      truncated: false,
      nodes: [
        { ref: 'e1', depth: 0, role: 'frame' },
        { ref: 'e2', depth: 1, role: 'push button', states: ['disabled'], actions: ['click'] },
      ],
    });

    await service.startupCheck();
    expect(log).toContain('info: Accessibility: thunar publishes a tree (4).');
    expect(log).toContain('warn: Accessibility: no tree from libreoffice.');
  });

  it('maps a stale ref to the protocol error the model must see', async () => {
    const { service } = await make();
    await service.start();
    await expect(
      service.act({ snapshot: 's1', ref: 'e999', action: 'click' }),
    ).rejects.toMatchObject({
      code: 'stale',
      status: 409,
      message: 'stale, take a new snapshot',
    });
  });

  it('kills a hung helper, fails the request in flight and starts fresh, never replaying', async () => {
    const { service, ops } = await make({ mode: 'hang-once', timeoutMs: 2_000 });
    await service.start();
    await expect(service.tree({ window: 'Thunar' })).rejects.toMatchObject({ status: 503 });
    // The next request starts a new helper (the marker makes this process answer) and succeeds.
    await expect(service.tree({ window: 'Thunar' })).resolves.toMatchObject({ snapshot: 's1' });
    const calls = await ops();
    expect(calls.filter((op) => op === 'tree')).toHaveLength(2);
  });

  it('kills a helper that writes a line over the cap, and refuses to parse it', async () => {
    const { service } = await make({ mode: 'huge', maxLineBytes: 1_024 });
    await service.start();
    await expect(service.tree({ window: 'Thunar' })).rejects.toMatchObject({ status: 503 });
    expect(service.available).toBe(false);
  });

  it('kills a helper that writes invalid JSON', async () => {
    const { service } = await make({ mode: 'garbage' });
    await service.start();
    await expect(service.tree({ window: 'Thunar' })).rejects.toMatchObject({ status: 503 });
  });

  it('reports the helper as down after it dies', async () => {
    const { service } = await make({ mode: 'die' });
    await service.start();
    await expect(service.tree({ window: 'Thunar' })).rejects.toMatchObject({ status: 503 });
    expect(service.available).toBe(false);
    await expect(service.status()).resolves.toMatchObject({
      helper: false,
      missing: ['chromium', 'libreoffice', 'thunar', 'xfce4-terminal'],
    });
  });
});
