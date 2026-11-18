import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxHttpError } from '../src/errors.js';
import { SandboxPaths } from '../src/paths.js';

let base: string;
let paths: SandboxPaths;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-paths-'));
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  paths = new SandboxPaths({
    workspace: { dir: path.join(base, 'workspace') },
    handoff: { dir: path.join(base, 'handoff'), readOnly: true },
  });
  await paths.start();
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SandboxHttpError);
  return (error as SandboxHttpError).code;
};

describe('sandbox paths confine the model to the roots (F08, S45)', () => {
  it('resolves a file inside the workspace', async () => {
    fs.writeFileSync(path.join(base, 'workspace', 'notes.txt'), 'hello');

    const real = await paths.resolveExisting('workspace', 'notes.txt');

    expect(real).toBe(fs.realpathSync(path.join(base, 'workspace', 'notes.txt')));
  });

  it('refuses absolute paths, .. and the other root', async () => {
    expect(await codeOf(paths.resolveExisting('workspace', '/etc/passwd'))).toBe('outside_root');
    expect(await codeOf(paths.resolveExisting('workspace', '../outside/secret.txt'))).toBe(
      'outside_root',
    );
    expect(await codeOf(paths.resolveExisting('workspace', 'a/../../x'))).toBe('outside_root');
    expect(await codeOf(paths.resolveExisting('workspace', 'C:/Windows/win.ini'))).toBe(
      'outside_root',
    );
  });

  it('refuses a symlink planted inside the workspace that points outside', async () => {
    // A junction links folders without special rights on Windows; on Linux this is a symlink.
    fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'workspace', 'link'), 'junction');

    // Reading through the folder link is refused.
    expect(await codeOf(paths.resolveExisting('workspace', 'link/secret.txt'))).toBe(
      'outside_root',
    );
    // Writing through it is refused too.
    expect(await codeOf(paths.resolveForWrite('workspace', 'link/new.txt', true))).toBe(
      'outside_root',
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a file link that points outside', async () => {
    fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(base, 'workspace', 'file'));
    expect(await codeOf(paths.resolveExisting('workspace', 'file'))).toBe('outside_root');
    expect(await codeOf(paths.resolveForWrite('workspace', 'file', true))).toBe('outside_root');
  });

  it('allows a link that stays inside the workspace', async () => {
    fs.mkdirSync(path.join(base, 'workspace', 'real'));
    fs.writeFileSync(path.join(base, 'workspace', 'real', 'a.txt'), 'a');
    fs.symlinkSync('real', path.join(base, 'workspace', 'alias'), 'junction');

    await expect(paths.resolveExisting('workspace', 'alias/a.txt')).resolves.toBe(
      fs.realpathSync(path.join(base, 'workspace', 'real', 'a.txt')),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to write through a dangling link, because it cannot prove where it lands',
    async () => {
      fs.symlinkSync(
        path.join(base, 'outside', 'made-by-link.txt'),
        path.join(base, 'workspace', 'dangling'),
      );

      expect(await codeOf(paths.resolveForWrite('workspace', 'dangling', true))).toBe(
        'outside_root',
      );
    },
  );

  it('gives a new file a path inside the workspace, and honours createParents', async () => {
    const file = await paths.resolveForWrite('workspace', 'fresh/dir/a.txt', true);
    expect(file.startsWith(fs.realpathSync(path.join(base, 'workspace')))).toBe(true);

    expect(await codeOf(paths.resolveForWrite('workspace', 'missing/dir/a.txt', false))).toBe(
      'not_found',
    );
  });

  it('makes the handoff folder read-only', async () => {
    fs.writeFileSync(path.join(base, 'handoff', 'report.pdf'), 'pdf');
    await expect(paths.resolveExisting('handoff', 'report.pdf')).resolves.toContain('report.pdf');
    expect(await codeOf(paths.resolveForWrite('handoff', 'new.txt', true))).toBe('read_only');
  });
});
