import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_TOKEN_HEADER } from '@shitsuji/sandbox-protocol';
import { SandboxFilesService } from '../src/files.js';
import { SandboxPaths } from '../src/paths.js';
import { createSandboxServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789';

let base: string;
let server: ReturnType<typeof createSandboxServer>;
let url: string;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-server-'));
  const paths = new SandboxPaths({
    workspace: { dir: path.join(base, 'workspace') },
    handoff: { dir: path.join(base, 'handoff'), readOnly: true },
  });
  await paths.start();
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  server = createSandboxServer({ token: TOKEN, files: new SandboxFilesService(paths) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

const call = (route: string, options: { method?: string; token?: string; body?: unknown } = {}) =>
  fetch(`${url}${route}`, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token !== undefined && { [SANDBOX_TOKEN_HEADER]: options.token }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });

describe('sandboxd HTTP surface (F08, S45)', () => {
  it('answers health without a token, and says it has no exec yet', async () => {
    const health = await call('/health', { method: 'GET' });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: 1 });

    const capabilities = await call('/capabilities', { method: 'GET', token: TOKEN });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      version: 1,
      files: { roots: ['workspace', 'handoff'] },
      exec: null,
    });
  });

  it('refuses every other route without the right token, in constant-time shape', async () => {
    for (const token of [undefined, '', 'wrong']) {
      const response = await call('/files/read', {
        token,
        body: { root: 'workspace', path: 'a.txt' },
      });
      expect(response.status, String(token)).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
  });

  it('writes, reads, lists, stats and moves through the routes', async () => {
    const write = await call('/files/write', {
      token: TOKEN,
      body: { root: 'workspace', path: 'notes/a.txt', content: 'chestnut' },
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ bytes: 8 });

    const read = await call('/files/read', {
      token: TOKEN,
      body: { root: 'workspace', path: 'notes/a.txt' },
    });
    expect(await read.json()).toEqual({ encoding: 'text', content: 'chestnut', bytes: 8 });

    const list = await call('/files/list', {
      token: TOKEN,
      body: { root: 'workspace', path: 'notes' },
    });
    expect(await list.json()).toEqual({
      entries: [{ name: 'a.txt', directory: false, size: 8 }],
    });

    const stat = await call('/files/stat', {
      token: TOKEN,
      body: { root: 'workspace', path: 'notes/a.txt' },
    });
    expect(await stat.json()).toMatchObject({ exists: true, size: 8, isFile: true });

    const move = await call('/files/move', {
      token: TOKEN,
      body: { root: 'workspace', from: 'notes/a.txt', to: 'notes/b.txt' },
    });
    expect(await move.json()).toEqual({ moved: true });
  });

  it('answers a missing file with 404 and an escape with 403', async () => {
    const missing = await call('/files/read', {
      token: TOKEN,
      body: { root: 'workspace', path: 'nope.txt' },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });

    fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'workspace', 'link'), 'junction');
    const escape = await call('/files/read', {
      token: TOKEN,
      body: { root: 'workspace', path: 'link/secret.txt' },
    });
    expect(escape.status).toBe(403);
    const reply = (await escape.json()) as { error: { code: string; message: string } };
    expect(reply.error.code).toBe('outside_root');
    expect(reply.error.message).not.toContain(base); // no host paths in messages
  });

  it('rejects a bad body, an unknown root and an unknown route', async () => {
    const badJson = await fetch(`${url}/files/read`, {
      method: 'POST',
      headers: { [SANDBOX_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);

    const badRoot = await call('/files/read', {
      token: TOKEN,
      body: { root: 'root', path: 'a.txt' },
    });
    expect(badRoot.status).toBe(400);
    expect(await badRoot.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const unknown = await call('/files/delete', { token: TOKEN, body: {} });
    expect(unknown.status).toBe(404);
  });
});
