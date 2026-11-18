import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { HostSandboxDriver } from '../../../../src/adapters/sandbox/host/HostSandboxDriver.js';
import { asId, type OwnerId } from '../../../../src/domain/model/ids.js';
import { describeSandboxContract } from '../../../contracts/sandbox.contract.js';

// The host driver runs the whole suite in unit tests, except what it makes no claim about: it has no
// PID limit (F08) and no egress control (it reports lanBlocked: false).
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-contract-host-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const workspaceDir = path.join(base, 'workspace');
const handoffDir = path.join(base, 'handoff');

await describeSandboxContract({
  name: 'host',
  driver: new HostSandboxDriver({
    workspaceDir,
    readDirs: [handoffDir],
    exec: { enabled: true, maxTimeoutSeconds: 60 },
  }),
  lease: { ownerId: asId<OwnerId>('owner') },
  printOne: { program: process.execPath, args: ['-e', 'console.log(1)'] },
  processContainment: false,
});
