import { describe, expect, it } from 'vitest';
import { capabilitiesReplySchema } from '@shitsuji/sandbox-protocol';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';
import {
  SandboxClient,
  SandboxRequestError,
  ShitsujiEgress,
  ShitsujiExec,
  ShitsujiFiles,
  type ShitsujiSandbox,
} from '../../../src/adapters/sandbox/shitsuji/ShitsujiSandbox.js';
import { ShitsujiSandboxDriver } from '../../../src/adapters/sandbox/shitsuji/ShitsujiSandboxDriver.js';
import { SandboxUnavailable } from '../../../src/domain/errors.js';
import type { ExecEvent, ExecRequest } from '../../../src/ports/SandboxDriver.js';

/** Records the daemon calls a driver piece makes and answers them from a table. */
const fakeClient = (
  answers: Record<string, (body: unknown) => unknown> = {},
): {
  client: SandboxClient;
  calls: { route: string; body: unknown }[];
} => {
  const calls: { route: string; body: unknown }[] = [];
  const client = {
    call: async (route: string, _schema: unknown, body?: unknown) => {
      calls.push({ route, body });
      const answer = answers[route];
      if (!answer) throw new Error(`unexpected route ${route}`);
      return answer(body);
    },
  } as unknown as SandboxClient;
  return { client, calls };
};

const streamOf = (frames: unknown[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
      }
      controller.close();
    },
  });

describe('shitsuji files (F08, S48)', () => {
  it('maps the workspace paths the tools pass around', async () => {
    const { client } = fakeClient();
    const files = new ShitsujiFiles(client);

    await expect(files.resolve('notes/a.txt')).resolves.toBe('/workspace/notes/a.txt');
    await expect(files.resolve('.')).resolves.toBe('/workspace');
    await expect(files.resolve('/etc/passwd')).rejects.toThrow(/absolute/);
    expect(files.display('/workspace/notes/a.txt')).toBe('notes/a.txt');
    expect(files.display('/handoff/report.pdf')).toBe('report.pdf');
  });

  it('sends read, write, mkdir and list with the root and relative path', async () => {
    const { client, calls } = fakeClient({
      '/files/write': () => ({ bytes: 3 }),
      '/files/read': () => ({ encoding: 'text', content: 'abc', bytes: 3 }),
      '/files/mkdir': () => ({ created: true }),
      '/files/list': () => ({ entries: [{ name: 'a.txt', directory: false, size: 3 }] }),
    });
    const files = new ShitsujiFiles(client);

    await files.write('/workspace/notes/a.txt', 'abc', { append: true });
    await expect(files.read('/handoff/report.txt')).resolves.toBe('abc');
    await files.mkdir('/workspace/shared');
    await expect(files.list('/workspace/notes')).resolves.toEqual([
      { name: 'a.txt', directory: false, size: 3 },
    ]);

    expect(calls).toEqual([
      {
        route: '/files/write',
        body: {
          root: 'workspace',
          path: 'notes/a.txt',
          encoding: 'text',
          content: 'abc',
          append: true,
          createParents: true,
        },
      },
      { route: '/files/read', body: { root: 'handoff', path: 'report.txt', encoding: 'text' } },
      { route: '/files/mkdir', body: { root: 'workspace', path: 'shared' } },
      { route: '/files/list', body: { root: 'workspace', path: 'notes' } },
    ]);
  });

  it('decodes base64 reads, and says a missing file has no stat', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    const { client } = fakeClient({
      '/files/read': () => ({
        encoding: 'base64',
        content: png.toString('base64'),
        bytes: png.length,
      }),
      '/files/stat': () => ({ exists: false }),
    });
    const files = new ShitsujiFiles(client);

    expect(Array.from(await files.readBytes('/workspace/photo.png'))).toEqual(Array.from(png));
    await expect(files.stat('/workspace/missing')).resolves.toBeUndefined();
  });

  it('finds a bare attachment name in the handoff folder, and refuses a host path', async () => {
    const { client, calls } = fakeClient({
      '/files/stat': (body) =>
        (body as { root: string; path: string }).root === 'handoff'
          ? { exists: true, size: 1, isFile: true, isDirectory: false }
          : { exists: false },
    });
    const files = new ShitsujiFiles(client);

    await expect(files.resolveRead('report.pdf')).resolves.toBe('/handoff/report.pdf');
    await expect(files.resolveRead('/etc/passwd')).rejects.toThrow(/outside/);
    expect(calls[0]).toMatchObject({ body: { root: 'workspace', path: 'report.pdf' } });
  });

  it('turns a not_found list into undefined', async () => {
    const { client } = fakeClient({
      '/files/list': () => {
        throw new SandboxRequestError('"nope" does not exist.', 'not_found');
      },
    });
    const files = new ShitsujiFiles(client);

    await expect(files.list('/workspace/nope')).resolves.toBeUndefined();
  });
});

describe('shitsuji exec (F08, S48)', () => {
  const request = (over: Partial<ExecRequest> = {}): ExecRequest => ({
    program: 'python3',
    args: ['-c', 'print(1)'],
    cwd: '/workspace/sub',
    timeoutMs: 5_000,
    ...over,
  });

  it('streams stdout and the exit, mapping cwd to a workspace path and the argv to the daemon', async () => {
    const calls: { body: unknown }[] = [];
    const client = {
      stream: async (_route: string, body: unknown) => {
        calls.push({ body });
        return streamOf([
          { type: 'start', id: 'c1' },
          { type: 'stdout', text: '1\n' },
          { type: 'exit', code: 0, timedOut: false, truncated: false },
        ]);
      },
    } as unknown as SandboxClient;
    const exec = new ShitsujiExec(client, 60_000);
    const events: ExecEvent[] = [];

    for await (const event of exec.run(request())) events.push(event);

    expect(calls[0]!.body).toMatchObject({
      argv: ['python3', '-c', 'print(1)'],
      cwd: 'sub',
      timeoutMs: 5_000,
    });
    expect(events).toEqual([
      { type: 'stdout', text: '1\n' },
      { type: 'exit', code: 0, timedOut: false, truncated: false },
    ]);
  });

  it('signals a command whose caller aborted, then reports it as stopped', async () => {
    const signals: string[] = [];
    const client = {
      stream: async () =>
        streamOf([
          { type: 'start', id: 'c9' },
          { type: 'exit', code: null, signal: 'SIGTERM', timedOut: true, truncated: false },
        ]),
      signal: async (id: string) => {
        signals.push(id);
      },
    } as unknown as SandboxClient;
    const exec = new ShitsujiExec(client, 60_000);
    const controller = new AbortController();
    controller.abort();

    const events: ExecEvent[] = [];
    await expect(
      (async () => {
        for await (const event of exec.run(request(), controller.signal)) events.push(event);
      })(),
    ).rejects.toThrow(/Stopped/);

    expect(signals).toEqual(['c9']);
    expect(events.at(-1)).toMatchObject({ type: 'exit', timedOut: true });
  });

  it('throws on an error frame', async () => {
    const client = {
      stream: async () =>
        streamOf([
          { type: 'start', id: 'c1' },
          { type: 'error', code: 'not_found', message: 'Program not found: nope' },
        ]),
    } as unknown as SandboxClient;
    const exec = new ShitsujiExec(client, 60_000);

    await expect(
      (async () => {
        for await (const _event of exec.run(request())) {
          // consume
        }
      })(),
    ).rejects.toThrow(/Program not found/);
  });
});

describe('shitsuji egress and client (F08, S48)', () => {
  it('asks the daemon whether an address answers', async () => {
    const { client, calls } = fakeClient({ '/probe': () => ({ reachable: true }) });
    const egress = new ShitsujiEgress(client);

    await expect(egress.reachable('192.168.1.1', 80, 1_000)).resolves.toBe(true);
    expect(calls[0]!.body).toEqual({ host: '192.168.1.1', port: 80, timeoutMs: 1_000 });
  });

  it('sends the token, validates replies and maps errors', async () => {
    const seen: { url: string; token: unknown }[] = [];
    const fetchOk = (async (url: string, init: RequestInit) => {
      seen.push({ url, token: (init.headers as Record<string, string>)['x-sandbox-token'] });
      return Response.json({
        version: 3,
        files: { roots: ['workspace', 'handoff'] },
        exec: { maxTimeoutMs: 3_600_000 },
      });
    }) as unknown as typeof fetch;
    const client = new SandboxClient({
      baseUrl: 'http://sandbox:4555/',
      token: 'secret',
      fetch: fetchOk,
    });

    await expect(client.call('/capabilities', capabilitiesReplySchema)).resolves.toMatchObject({
      version: 3,
    });
    expect(seen[0]).toEqual({ url: 'http://sandbox:4555/capabilities', token: 'secret' });

    const refusing = (async () =>
      Response.json(
        { error: { code: 'outside_root', message: 'no' } },
        { status: 403 },
      )) as unknown as typeof fetch;
    const refused = new SandboxClient({
      baseUrl: 'http://sandbox:4555',
      token: 'x',
      fetch: refusing,
    });
    await expect(refused.call('/files/read', capabilitiesReplySchema)).rejects.toMatchObject({
      code: 'outside_root',
    });

    const unreachable = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const down = new SandboxClient({
      baseUrl: 'http://sandbox:4555',
      token: 'x',
      fetch: unreachable,
    });
    await expect(down.health()).resolves.toMatchObject({ ok: false });
    expect(
      await down.call('/health', capabilitiesReplySchema).catch((e: unknown) => e),
    ).toBeInstanceOf(SandboxUnavailable);
  });

  it('reports the capabilities and opens a sandbox through the driver', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/capabilities')) {
        return Response.json({
          version: 3,
          files: { roots: ['workspace', 'handoff'] },
          exec: { maxTimeoutMs: 60_000 },
        });
      }
      if (url.endsWith('/health')) return Response.json({ ok: true, version: 3 });
      if (url.endsWith('/desktop/viewer-credentials')) {
        return Response.json({ viewOnly: 'view-only-pass' });
      }
      return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 });
    }) as unknown as typeof fetch;
    const driver = new ShitsujiSandboxDriver({
      baseUrl: 'http://sandbox:4555',
      token: 'x',
      log: new MemoryLogger(),
      fetch: fetchImpl,
    });

    await expect(driver.capabilities()).resolves.toEqual({
      files: { roots: ['/workspace', '/handoff'] },
      exec: { maxTimeoutMs: 60_000 },
      egress: { lanBlocked: true, credentialSwap: false },
    });
    await expect(driver.health()).resolves.toEqual({ ok: true });
    await expect(driver.viewerCredentials()).resolves.toEqual({
      viewOnlyPassword: 'view-only-pass',
    });
    const sandbox = (await driver.open({ ownerId: 'owner' as never })) as ShitsujiSandbox;
    expect(sandbox.files).toBeDefined();
    expect(sandbox.exec?.maxTimeoutMs).toBe(60_000);
  });
});
