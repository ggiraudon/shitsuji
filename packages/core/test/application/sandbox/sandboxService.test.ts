import { describe, expect, it, vi } from 'vitest';
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
const fakeFiles = (): SandboxFiles => ({
  resolve: async (p) => `/workspace/${p}`,
  resolveRead: async (p) => `/workspace/${p}`,
  display: (absolute) => absolute.replace('/workspace/', ''),
  read: async () => '',
  stat: async () => undefined,
  write: async () => undefined,
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
  open: async () => ({ close: vi.fn(async () => undefined), ...sandbox }),
  health: async () => ({ ok: healthOk, ...(healthOk ? {} : { detail: 'no sandbox runtime' }) }),
});

const service = (d: SandboxDriver) =>
  new SandboxService({ driver: d, lease: LEASE, exec: EXEC, log: testServices().log });

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
      'workspace.write',
      'workspace.list',
      'workspace.send',
    ]);
    expect(names(sandbox)).not.toContain('workspace.exec');
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
});
