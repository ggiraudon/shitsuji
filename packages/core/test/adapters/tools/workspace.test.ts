import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceExecTool,
  WorkspaceListTool,
  WorkspaceReadTool,
  WorkspaceRoot,
  WorkspaceWriteTool,
} from '../../../src/adapters/tools/workspace.js';
import type { ToolContext } from '../../../src/ports/Tool.js';
import { testServices } from '../../helpers.js';

let base: string;
let ws: WorkspaceRoot;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-ws-'));
  ws = new WorkspaceRoot(path.join(base, 'workspace'));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const ctx = (signal = new AbortController().signal): ToolContext => {
  const s = testServices();
  return {
    turnId: 't',
    sessionId: 's',
    signal,
    log: s.log,
    events: s.events,
    writeFenced: async () => {
      throw new Error('unused');
    },
  };
};

describe('WorkspaceRoot confinement (decision Q1)', () => {
  it('resolves paths inside the workspace and creates the folder', async () => {
    const p = await ws.resolve('notes/today.md');
    expect(p.startsWith(await ws.root())).toBe(true);
    expect(fs.existsSync(path.join(base, 'workspace'))).toBe(true);
  });

  it.each(['../outside.txt', 'a/../../outside.txt', '..'])('refuses %s', async (p) => {
    await expect(ws.resolve(p)).rejects.toThrow(/outside the workspace/);
  });

  it('refuses absolute paths', async () => {
    await expect(ws.resolve(path.join(base, 'x'))).rejects.toThrow(/absolute/);
    await expect(ws.resolve('/etc/passwd')).rejects.toThrow(/absolute/);
  });

  it('refuses a link that points outside', async () => {
    const outside = path.join(base, 'secret');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'key.txt'), 'sk-123');
    await ws.root();
    // A junction needs no special rights on Windows; on Linux and macOS this is a plain symlink.
    fs.symlinkSync(outside, path.join(base, 'workspace', 'link'), 'junction');
    await expect(ws.resolve('link/key.txt')).rejects.toThrow(/through a link/);
    await expect(ws.resolve('link/new.txt')).rejects.toThrow(/through a link/);
  });
});

describe('workspace file tools', () => {
  it('write, append, read and list', async () => {
    const write = new WorkspaceWriteTool(ws);
    await write.run({ path: 'docs/a.txt', content: 'hello', append: false });
    await write.run({ path: 'docs/a.txt', content: ' world', append: true });
    expect((await new WorkspaceReadTool(ws).run({ path: 'docs/a.txt' })).content).toBe(
      'hello world',
    );
    expect((await new WorkspaceListTool(ws).run({ path: '.' })).content).toBe('docs/');
    expect((await new WorkspaceListTool(ws).run({ path: 'docs' })).content).toBe('a.txt');
  });

  it('reports a missing file or folder as a tool error, not an exception', async () => {
    expect(await new WorkspaceReadTool(ws).run({ path: 'nope.txt' })).toMatchObject({
      isError: true,
    });
    expect(await new WorkspaceListTool(ws).run({ path: 'nope' })).toMatchObject({ isError: true });
  });
});

describe('workspace.exec', () => {
  const exec = (opts: Partial<{ defaultTimeoutSeconds: number }> = {}) =>
    new WorkspaceExecTool(ws, {
      defaultTimeoutSeconds: opts.defaultTimeoutSeconds ?? 20,
      maxTimeoutSeconds: 60,
      maxOutputBytes: 10_000,
    });
  const node = process.execPath;

  it('runs a program in the workspace and returns exit code and output', async () => {
    const out = await exec().run(
      {
        program: node,
        args: ['-e', 'console.log(process.cwd().endsWith("workspace") ? "in ws" : "elsewhere")'],
        cwd: '.',
      },
      ctx(),
    );
    expect(out).toMatchObject({ isError: false, data: { exitCode: 0 } });
    expect(out.content).toBe('exit code 0\nin ws');
  });

  it('passes arguments without a shell, so ";" and "&&" are just text', async () => {
    const out = await exec().run(
      {
        program: node,
        args: ['-e', 'console.log(process.argv.slice(1).join("|"))', 'a; rm -rf ~', '&& echo hi'],
        cwd: '.',
      },
      ctx(),
    );
    expect(out.content).toBe('exit code 0\na; rm -rf ~|&& echo hi');
  });

  it('reports a non-zero exit and a missing program', async () => {
    expect(
      await exec().run({ program: node, args: ['-e', 'process.exit(3)'], cwd: '.' }, ctx()),
    ).toMatchObject({
      isError: true,
      content: 'exit code 3',
    });
    expect(
      await exec().run({ program: 'no-such-program-xyz', args: [], cwd: '.' }, ctx()),
    ).toMatchObject({
      isError: true,
      content: 'Program not found: no-such-program-xyz',
    });
  });

  it('refuses a working folder outside the workspace', async () => {
    await expect(exec().run({ program: node, args: [], cwd: '..' }, ctx())).rejects.toThrow(
      /outside/,
    );
  });

  it('kills a program that runs past its timeout', async () => {
    const out = await exec().run(
      { program: node, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: '.', timeoutSeconds: 1 },
      ctx(),
    );
    expect(out).toMatchObject({ isError: true, data: { timedOut: true } });
    expect(out.content).toMatch(/timed out after 1s/);
  });

  it('stops the program on Stop', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = exec().run(
      { program: node, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: '.' },
      ctx(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
