import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxFilesService } from '../src/files.js';
import { SandboxHttpError } from '../src/errors.js';
import { SandboxPaths } from '../src/paths.js';

let base: string;
let files: SandboxFilesService;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-files-'));
  const paths = new SandboxPaths({
    workspace: { dir: path.join(base, 'workspace') },
    handoff: { dir: path.join(base, 'handoff'), readOnly: true },
  });
  await paths.start();
  files = new SandboxFilesService(paths);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SandboxHttpError);
  return (error as SandboxHttpError).code;
};

describe('sandbox files API (F08, S45)', () => {
  it('writes text, appends, and reads it back as text and as bytes', async () => {
    const write = await files.write('workspace', {
      root: 'workspace',
      path: 'docs/a.txt',
      encoding: 'text',
      content: 'hello',
      append: false,
      createParents: true,
    });
    expect(write.bytes).toBe(5);
    await files.write('workspace', {
      root: 'workspace',
      path: 'docs/a.txt',
      encoding: 'text',
      content: ' world',
      append: true,
      createParents: true,
    });

    expect(await files.read('workspace', 'docs/a.txt', 'text')).toEqual({
      encoding: 'text',
      content: 'hello world',
      bytes: 11,
    });
    const bytes = await files.read('workspace', 'docs/a.txt', 'base64');
    expect(Buffer.from(bytes.content, 'base64').toString('utf8')).toBe('hello world');
  });

  it('keeps a binary file byte for byte through base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);

    await files.write('workspace', {
      root: 'workspace',
      path: 'photo.png',
      encoding: 'base64',
      content: png.toString('base64'),
      append: false,
      createParents: true,
    });

    const read = await files.read('workspace', 'photo.png', 'base64');
    expect(read.bytes).toBe(png.length);
    expect(Buffer.from(read.content, 'base64').equals(png)).toBe(true);
  });

  it('lists a folder with names, kinds and sizes', async () => {
    await files.write('workspace', {
      root: 'workspace',
      path: 'dir/a.txt',
      encoding: 'text',
      content: 'abc',
      append: false,
      createParents: true,
    });
    fs.mkdirSync(path.join(base, 'workspace', 'dir', 'sub'));

    expect(await files.list('workspace', 'dir')).toEqual({
      entries: [
        { name: 'a.txt', directory: false, size: 3 },
        { name: 'sub', directory: true, size: expect.any(Number) },
      ],
    });
  });

  it('stats an existing file and says a missing one does not exist', async () => {
    await files.write('workspace', {
      root: 'workspace',
      path: 'a.txt',
      encoding: 'text',
      content: 'hello',
      append: false,
      createParents: true,
    });

    expect(await files.stat('workspace', 'a.txt')).toMatchObject({
      exists: true,
      size: 5,
      isFile: true,
      isDirectory: false,
    });
    expect(await files.stat('workspace', 'nope.txt')).toEqual({ exists: false });
  });

  it('creates a folder inside the workspace, and refuses the read-only root', async () => {
    expect(await files.mkdir('workspace', 'shared/tools')).toEqual({ created: true });
    expect(fs.statSync(path.join(base, 'workspace', 'shared', 'tools')).isDirectory()).toBe(true);
    expect(await codeOf(files.mkdir('handoff', 'outbox'))).toBe('read_only');
  });

  it('moves a file, refusing to overwrite unless asked', async () => {
    const write = (name: string, content: string) =>
      files.write('workspace', {
        root: 'workspace',
        path: name,
        encoding: 'text',
        content,
        append: false,
        createParents: true,
      });
    await write('a.txt', 'a');
    await write('b.txt', 'b');

    expect(
      await codeOf(
        files.move('workspace', {
          root: 'workspace',
          from: 'a.txt',
          to: 'b.txt',
          overwrite: false,
        }),
      ),
    ).toBe('already_exists');
    expect(
      await files.move('workspace', {
        root: 'workspace',
        from: 'a.txt',
        to: 'b.txt',
        overwrite: true,
      }),
    ).toEqual({
      moved: true,
    });
    expect(await files.read('workspace', 'b.txt', 'text')).toMatchObject({ content: 'a' });
    expect(await files.stat('workspace', 'a.txt')).toEqual({ exists: false });
  });

  it('refuses to read a folder and to write the handoff root', async () => {
    expect(await codeOf(files.read('workspace', '.', 'text'))).toBe('invalid_request');
    expect(
      await codeOf(
        files.write('handoff', {
          root: 'handoff',
          path: 'x.txt',
          encoding: 'text',
          content: 'x',
          append: false,
          createParents: true,
        }),
      ),
    ).toBe('read_only');
  });
});
