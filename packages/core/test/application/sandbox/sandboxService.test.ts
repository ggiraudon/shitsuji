import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { EgressProbe, type EgressTarget } from '../../../src/application/sandbox/EgressProbe.js';
import { SandboxService } from '../../../src/application/sandbox/SandboxService.js';
import { SandboxUnavailable } from '../../../src/domain/errors.js';
import { asId, type OwnerId } from '../../../src/domain/model/ids.js';
import type {
  ExecEvent,
  LeaseRequest,
  Sandbox,
  SandboxCapabilities,
  SandboxDriver,
  SandboxFiles,
} from '../../../src/ports/SandboxDriver.js';
import { testServices } from '../../helpers.js';

const LEASE: LeaseRequest = { ownerId: asId<OwnerId>('owner') };
const EXEC = { defaultTimeoutSeconds: 10, maxTimeoutSeconds: 60, maxOutputBytes: 1_000 };

/** Enough of the files port for the tools to be built; nothing here reads a real file. */
const fakeFiles = (mkdirs: string[] = []): SandboxFiles => ({
  resolve: async (p) => `/workspace/${p}`,
  resolveRead: async (p) => `/workspace/${p}`,
  display: (absolute) => absolute.replace('/workspace/', ''),
  read: async () => '',
  readBytes: async () => new Uint8Array(),
  stat: async () => undefined,
  write: async () => undefined,
  mkdir: async (absolute) => {
    mkdirs.push(absolute);
  },
  list: async () => [],
});

const fakeExec = {
  maxTimeoutMs: 60_000,
  async *run(): AsyncIterable<ExecEvent> {
    yield { type: 'exit', code: 0, timedOut: false };
  },
};

const driver = (
  capabilities: SandboxCapabilities,
  sandbox: Partial<Sandbox> = { files: fakeFiles() },
  healthOk = true,
): SandboxDriver => ({
  id: 'fake',
  capabilities: async () => capabilities,
  open: async () => ({
    close: vi.fn(async () => undefined),
    egress: { reachable: async () => false },
    ...sandbox,
  }),
  health: async () => ({ ok: healthOk, ...(healthOk ? {} : { detail: 'no sandbox runtime' }) }),
});

const LAN: EgressTarget = { label: 'LAN', host: '192.168.1.1', port: 80 };

/** A tool with the fields a driver's extra tool needs. */
const fakeTool = (name: string) => ({
  name,
  description: name,
  input: z.object({}),
  effect: 'read' as const,
  target: 'workspace' as const,
  deferred: false,
  untrustedOutput: false,
  run: async () => ({ content: '' }),
});

const build = (d: SandboxDriver, retry = { attempts: 1, delayMs: 0 }) => {
  const services = testServices();
  const sandbox = new SandboxService({
    driver: d,
    lease: LEASE,
    exec: EXEC,
    outbound: { stage: async (name) => `/outbox/${name}` },
    egress: new EgressProbe({ targets: [LAN], timeoutMs: 10, log: services.log }),
    log: services.log,
    retry,
  });
  return { sandbox, log: services.log };
};

const service = (d: SandboxDriver) => build(d).sandbox;

const names = (s: SandboxService) => s.tools().map((tool) => tool.name);

describe('SandboxService (F08, S40)', () => {
  it('registers the file tools, and no exec, for a driver without exec', async () => {
    const sandbox = service(
      driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: true, credentialSwap: false },
      }),
    );
    expect(sandbox.tools()).toEqual([]); // nothing before start()

    await sandbox.start();

    expect(names(sandbox)).toEqual([
      'workspace.read',
      'workspace.edit',
      'workspace.find',
      'workspace.write',
      'workspace.list',
      'workspace.send',
    ]);
    expect(names(sandbox)).not.toContain('workspace.exec');
  });

  it('creates the shared and tools folders at open (F08)', async () => {
    const mkdirs: string[] = [];
    const sandbox = service(
      driver(
        { files: { roots: ['/workspace'] }, egress: { lanBlocked: false, credentialSwap: false } },
        { files: fakeFiles(mkdirs) },
      ),
    );

    await sandbox.start();

    expect(mkdirs).toEqual(['/workspace/shared', '/workspace/tools']);
  });

  it('adds workspace.exec when the driver can run programs', async () => {
    const sandbox = service(
      driver(
        {
          files: { roots: ['/workspace'] },
          exec: { maxTimeoutMs: 60_000 },
          egress: { lanBlocked: true, credentialSwap: false },
        },
        { files: fakeFiles(), exec: fakeExec },
      ),
    );

    await sandbox.start();

    expect(names(sandbox)).toContain('workspace.exec');
  });

  it('refuses a driver whose lanBlocked claim the probe contradicts (S42)', async () => {
    const lying = driver(
      { files: { roots: ['/workspace'] }, egress: { lanBlocked: true, credentialSwap: false } },
      {
        files: fakeFiles(),
        egress: { reachable: async (host) => host === '192.168.1.1' },
      },
    );
    const sandbox = service(lying);

    await expect(sandbox.start()).rejects.toThrow(SandboxUnavailable);
    await expect(sandbox.start()).rejects.toThrow(/192\.168\.1\.1:80/);
    expect(sandbox.tools()).toEqual([]);
  });

  it('re-checks the egress claim on health() (S42)', async () => {
    let reachesLan = false;
    const sandbox = service(
      driver(
        { files: { roots: ['/workspace'] }, egress: { lanBlocked: true, credentialSwap: false } },
        {
          files: fakeFiles(),
          egress: { reachable: async () => reachesLan },
        },
      ),
    );
    await sandbox.start();
    expect(await sandbox.health()).toEqual({ ok: true });

    reachesLan = true;
    await expect(sandbox.health()).rejects.toThrow(SandboxUnavailable);
  });

  it('registers a driver tool named after it, and refuses one that is not (S42 review)', async () => {
    const good = {
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: false, credentialSwap: false },
      }),
      extraTools: () => [fakeTool('fake.hello')],
    };
    const sandbox = service(good);
    await sandbox.start();
    expect(names(sandbox)).toContain('fake.hello');

    const shadowing = {
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: false, credentialSwap: false },
      }),
      extraTools: () => [fakeTool('workspace.read')],
    };
    await expect(service(shadowing).start()).rejects.toThrow(/must be named "fake\.\*"/);

    const twice = {
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: false, credentialSwap: false },
      }),
      extraTools: () => [fakeTool('fake.hello'), fakeTool('fake.hello')],
    };
    await expect(service(twice).start()).rejects.toThrow(/twice/);
  });

  it('names a handoff attachment the way the active driver does (#100)', async () => {
    const files: SandboxFiles = {
      ...fakeFiles(),
      resolveRead: async (name) => `/handoff/${name}`,
      display: (absolute) => absolute.replace('/handoff/', ''),
    };
    const { sandbox } = build(
      driver(
        {
          files: { roots: ['/workspace', '/handoff'] },
          egress: { lanBlocked: true, credentialSwap: false },
        },
        { files },
      ),
    );
    await sandbox.start();

    await expect(sandbox.attachmentPath('/data/handoff/photo.jpg')).resolves.toBe(
      '/handoff/photo.jpg',
    );
  });

  it('closes the sandbox and forgets its tools on close', async () => {
    const close = vi.fn(async () => undefined);
    const sandbox = service(
      driver(
        { files: { roots: ['/workspace'] }, egress: { lanBlocked: false, credentialSwap: false } },
        {
          files: fakeFiles(),
          close,
        },
      ),
    );
    await sandbox.start();

    await sandbox.close();

    expect(close).toHaveBeenCalledOnce();
    expect(sandbox.tools()).toEqual([]);
  });

  it('refuses a driver that is not healthy, and opens nothing', async () => {
    const open = vi.fn(async () => ({ files: fakeFiles(), close: async () => undefined }));
    const sandbox = service({
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: false, credentialSwap: false },
      }),
      health: async () => ({ ok: false, detail: 'no sandbox runtime' }),
      open,
    });

    await expect(sandbox.start()).rejects.toThrow(SandboxUnavailable);
    await expect(sandbox.start()).rejects.toThrow(/no sandbox runtime/);
    expect(open).not.toHaveBeenCalled();
  });

  it('waits a bounded time for a cold sandbox, logging each attempt (S49)', async () => {
    let checks = 0;
    const cold = {
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: true, credentialSwap: false },
      }),
      health: async () => {
        checks += 1;
        return checks < 3
          ? { ok: false as const, detail: 'sandboxd is starting' }
          : { ok: true as const };
      },
    };
    const { sandbox, log } = build(cold, { attempts: 5, delayMs: 1 });

    await sandbox.start();

    expect(checks).toBe(3);
    const retries = log.records.filter(
      (record) => record.message === 'Sandbox not ready; retrying',
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]!.context).toMatchObject({
      driver: 'fake',
      attempt: 1,
      attempts: 5,
      detail: 'sandboxd is starting',
    });
    expect(names(sandbox)).toContain('workspace.read');
  });

  it('gives up after the bounded attempts (S49)', async () => {
    const never = {
      ...driver({
        files: { roots: ['/workspace'] },
        egress: { lanBlocked: true, credentialSwap: false },
      }),
      health: async () => ({ ok: false as const, detail: 'still starting' }),
    };
    const { sandbox } = build(never, { attempts: 3, delayMs: 1 });

    await expect(sandbox.start()).rejects.toThrow(/still starting/);
  });
});
