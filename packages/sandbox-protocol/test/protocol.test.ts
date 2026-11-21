import { describe, expect, it } from 'vitest';
import {
  SANDBOX_MAX_TIMEOUT_MS,
  capabilitiesReplySchema,
  desktopA11yActRequestSchema,
  desktopA11yFindQuerySchema,
  desktopA11yTreeQuerySchema,
  desktopKeyboardRequestSchema,
  desktopMouseRequestSchema,
  desktopScreenshotReplySchema,
  errorReplySchema,
  execEventSchema,
  execRequestSchema,
  healthReplySchema,
  isRelativePath,
  mkdirReplySchema,
  mkdirRequestSchema,
  moveFileRequestSchema,
  probeReplySchema,
  probeRequestSchema,
  readFileReplySchema,
  readFileRequestSchema,
  sandboxPathSchema,
  signalExecRequestSchema,
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

describe('sandbox protocol: exec (S46)', () => {
  it('defaults argv-only requests to the workspace, no extra env, ten minutes', () => {
    expect(execRequestSchema.parse({ argv: ['python3', '-c', 'print(1)'] })).toEqual({
      argv: ['python3', '-c', 'print(1)'],
      cwd: '.',
      env: {},
      timeoutMs: 600_000,
    });
  });

  it('refuses an empty argv, a cwd outside and an absurd timeout', () => {
    expect(execRequestSchema.safeParse({ argv: [] }).success).toBe(false);
    expect(execRequestSchema.safeParse({ argv: ['x'], cwd: '../etc' }).success).toBe(false);
    expect(
      execRequestSchema.safeParse({ argv: ['x'], timeoutMs: SANDBOX_MAX_TIMEOUT_MS + 1 }).success,
    ).toBe(false);
  });

  it('validates every frame of the NDJSON stream', () => {
    for (const event of [
      { type: 'start', id: 'c1' },
      { type: 'stdout', text: '1\n' },
      { type: 'stderr', text: 'boo\n' },
      { type: 'exit', code: 0, timedOut: false, truncated: false },
      { type: 'exit', code: null, signal: 'SIGTERM', timedOut: true, truncated: true },
      { type: 'error', code: 'not_found', message: 'no such program' },
    ]) {
      expect(execEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
    expect(execEventSchema.safeParse({ type: 'exit', code: 'zero' }).success).toBe(false);
    expect(execEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('defaults a stop to TERM with a two second grace', () => {
    expect(signalExecRequestSchema.parse({})).toEqual({ signal: 'SIGTERM', graceMs: 2_000 });
    expect(signalExecRequestSchema.safeParse({ signal: 'SIGKILL', graceMs: 0 }).success).toBe(true);
    expect(signalExecRequestSchema.safeParse({ signal: 'SIGSEGV' }).success).toBe(false);
  });
});

describe('sandbox protocol: mkdir and probe (S48)', () => {
  it('defaults a mkdir to creating parents, and validates a probe', () => {
    expect(mkdirRequestSchema.parse({ root: 'workspace', path: 'shared' })).toEqual({
      root: 'workspace',
      path: 'shared',
      createParents: true,
    });
    expect(mkdirReplySchema.parse({ created: true })).toEqual({ created: true });
    expect(probeRequestSchema.parse({ host: 'core', port: 3001 })).toEqual({
      host: 'core',
      port: 3001,
      timeoutMs: 2_000,
    });
    expect(probeReplySchema.parse({ reachable: false })).toEqual({ reachable: false });
    expect(probeRequestSchema.safeParse({ host: 'core', port: 0 }).success).toBe(false);
  });
});

describe('sandbox protocol: health, capabilities and errors', () => {
  it('reports the exec timeout it allows, and a version', () => {
    expect(
      capabilitiesReplySchema.parse({
        version: 3,
        files: { roots: ['workspace', 'handoff'] },
        exec: { maxTimeoutMs: 3_600_000 },
      }),
    ).toMatchObject({ exec: { maxTimeoutMs: 3_600_000 } });
    expect(
      capabilitiesReplySchema.safeParse({
        version: 3,
        files: { roots: ['workspace'] },
        exec: null,
      }).success,
    ).toBe(false);
  });

  it('validates health and the error envelope', () => {
    expect(healthReplySchema.parse({ ok: true, version: 3 })).toEqual({ ok: true, version: 3 });
    expect(
      errorReplySchema.parse({ error: { code: 'outside_root', message: 'no' } }),
    ).toMatchObject({ error: { code: 'outside_root' } });
    expect(errorReplySchema.safeParse({ error: { code: 'oops', message: 'no' } }).success).toBe(
      false,
    );
  });
});

describe('sandbox protocol: desktop (S53)', () => {
  it('bounds coordinates and only accepts the closed mouse actions', () => {
    expect(desktopMouseRequestSchema.parse({ action: 'click', x: 10, y: 20 })).toMatchObject({
      action: 'click',
      button: 'left',
    });
    expect(desktopMouseRequestSchema.safeParse({ action: 'click', x: -1, y: 0 }).success).toBe(
      false,
    );
    expect(desktopMouseRequestSchema.safeParse({ action: 'run', x: 1, y: 2 }).success).toBe(false);
  });

  it('accepts typed text and allow-listed keys, never an arbitrary key', () => {
    expect(desktopKeyboardRequestSchema.parse({ action: 'type', text: 'hello' })).toEqual({
      action: 'type',
      text: 'hello',
    });
    expect(desktopKeyboardRequestSchema.parse({ action: 'key', key: 'ctrl+l' })).toEqual({
      action: 'key',
      key: 'ctrl+l',
    });
    expect(
      desktopKeyboardRequestSchema.safeParse({ action: 'key', key: 'ctrl+alt+delete' }).success,
    ).toBe(false);
  });

  it('requires a PNG screenshot with both sizes and the applied scale', () => {
    expect(
      desktopScreenshotReplySchema.parse({
        encoding: 'base64',
        content: 'AAAA',
        mediaType: 'image/png',
        width: 1280,
        height: 800,
        originalWidth: 1440,
        originalHeight: 900,
        scale: 1280 / 1440,
      }),
    ).toMatchObject({ mediaType: 'image/png' });
    expect(
      desktopScreenshotReplySchema.safeParse({
        encoding: 'base64',
        content: 'AAAA',
        mediaType: 'image/jpeg',
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        scale: 1,
      }).success,
    ).toBe(false);
  });
});

describe('sandbox protocol: accessibility tree (S54)', () => {
  it('accepts a window query, a sub-tree ref and a bounded depth', () => {
    expect(desktopA11yTreeQuerySchema.parse({ window: 'Thunar', ref: 'e12', depth: '3' })).toEqual({
      window: 'Thunar',
      ref: 'e12',
      depth: 3,
    });
    expect(desktopA11yTreeQuerySchema.safeParse({ ref: 'w1' }).success).toBe(false);
    expect(desktopA11yTreeQuerySchema.safeParse({ depth: 101 }).success).toBe(false);
  });

  it('requires a name or role for a find', () => {
    expect(desktopA11yFindQuerySchema.parse({ name: 'Save' })).toEqual({ name: 'Save' });
    expect(desktopA11yFindQuerySchema.safeParse({ window: 'Thunar' }).success).toBe(false);
  });

  it('takes text only with set_text, and only the closed action list', () => {
    expect(
      desktopA11yActRequestSchema.parse({
        snapshot: 's3',
        ref: 'e12',
        action: 'set_text',
        text: 'hello',
      }),
    ).toMatchObject({ action: 'set_text', text: 'hello' });
    expect(
      desktopA11yActRequestSchema.safeParse({ snapshot: 's3', ref: 'e12', action: 'set_text' })
        .success,
    ).toBe(false);
    expect(
      desktopA11yActRequestSchema.safeParse({
        snapshot: 's3',
        ref: 'e12',
        action: 'click',
        text: 'hello',
      }).success,
    ).toBe(false);
    expect(
      desktopA11yActRequestSchema.safeParse({ snapshot: 's3', ref: 'e12', action: 'run' }).success,
    ).toBe(false);
    expect(
      desktopA11yActRequestSchema.safeParse({ snapshot: 's3', ref: '/org/a11y/1', action: 'click' })
        .success,
    ).toBe(false);
  });
});
