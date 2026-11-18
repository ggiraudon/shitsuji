import { describe, expect, it } from 'vitest';
import {
  capabilitiesReplySchema,
  errorReplySchema,
  healthReplySchema,
  isRelativePath,
  moveFileRequestSchema,
  readFileReplySchema,
  readFileRequestSchema,
  sandboxPathSchema,
  statFileReplySchema,
  writeFileRequestSchema,
} from '../src/index.js';

describe('sandbox protocol: paths', () => {
  it('accepts a relative path and refuses the ways out', () => {
    for (const path of ['notes.txt', 'src/app.ts', 'docs/a b.md', '.hidden']) {
      expect(sandboxPathSchema.parse(path)).toBe(path);
    }
    for (const path of ['', '/etc/passwd', 'C:/Windows', '..', '../outside', 'a/../../x', 'a\0b']) {
      expect(sandboxPathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it('keeps isRelativePath simple and strict', () => {
    expect(isRelativePath('a/b.txt')).toBe(true);
    expect(isRelativePath('..\\outside')).toBe(false);
    expect(isRelativePath('//server/share')).toBe(false);
  });
});

describe('sandbox protocol: requests and replies', () => {
  it('defaults a read to text and carries a base64 read', () => {
    expect(readFileRequestSchema.parse({ root: 'workspace', path: 'a.txt' })).toEqual({
      root: 'workspace',
      path: 'a.txt',
      encoding: 'text',
    });
    expect(
      readFileReplySchema.parse({ encoding: 'base64', content: 'iVBORw0K', bytes: 8 }),
    ).toMatchObject({ encoding: 'base64', bytes: 8 });
  });

  it('defaults a write to text, not appending, creating parents', () => {
    expect(
      writeFileRequestSchema.parse({ root: 'workspace', path: 'a.txt', content: 'hi' }),
    ).toEqual({
      root: 'workspace',
      path: 'a.txt',
      encoding: 'text',
      content: 'hi',
      append: false,
      createParents: true,
    });
    expect(writeFileRequestSchema.safeParse({ root: 'workspace', path: 'a.txt' }).success).toBe(
      false,
    );
  });

  it('refuses an unknown root or an extra key', () => {
    expect(readFileRequestSchema.safeParse({ root: 'root', path: 'a.txt' }).success).toBe(false);
    expect(
      writeFileRequestSchema.safeParse({
        root: 'workspace',
        path: 'a.txt',
        content: 'x',
        encoding: 'utf8',
      }).success,
    ).toBe(false);
    expect(
      readFileRequestSchema.safeParse({ root: 'workspace', path: 'a.txt', extra: 1 }).success,
    ).toBe(false);
  });

  it('defaults a move to not overwriting', () => {
    expect(moveFileRequestSchema.parse({ root: 'handoff', from: 'a', to: 'b' })).toEqual({
      root: 'handoff',
      from: 'a',
      to: 'b',
      overwrite: false,
    });
  });

  it('allows a missing file as a stat answer, and nothing else odd', () => {
    expect(statFileReplySchema.parse({ exists: false })).toEqual({ exists: false });
    expect(
      statFileReplySchema.parse({ exists: true, size: 3, isFile: true, isDirectory: false }),
    ).toMatchObject({ exists: true, size: 3 });
    expect(statFileReplySchema.safeParse({ exists: true }).success).toBe(false);
  });
});

describe('sandbox protocol: health, capabilities and errors', () => {
  it('says plainly that there is no exec yet', () => {
    expect(
      capabilitiesReplySchema.parse({
        version: 1,
        files: { roots: ['workspace', 'handoff'] },
        exec: null,
      }),
    ).toMatchObject({ exec: null });
    expect(
      capabilitiesReplySchema.safeParse({
        version: 1,
        files: { roots: ['workspace'] },
        exec: { maxTimeoutMs: 1000 },
      }).success,
    ).toBe(false);
  });

  it('validates health and the error envelope', () => {
    expect(healthReplySchema.parse({ ok: true, version: 1 })).toEqual({ ok: true, version: 1 });
    expect(
      errorReplySchema.parse({ error: { code: 'outside_root', message: 'no' } }),
    ).toMatchObject({ error: { code: 'outside_root' } });
    expect(errorReplySchema.safeParse({ error: { code: 'oops', message: 'no' } }).success).toBe(
      false,
    );
  });
});
