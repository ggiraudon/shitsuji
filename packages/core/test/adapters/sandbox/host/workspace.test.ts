import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceEditTool,
  WorkspaceExecTool,
  WorkspaceFindTool,
  WorkspaceListTool,
  WorkspaceReadTool,
  WorkspaceSendTool,
  WorkspaceWriteTool,
} from '../../../../src/application/sandbox/tools/workspace.js';
import { WorkspaceRoot } from '../../../../src/adapters/sandbox/host/WorkspaceRoot.js';
import { HostExec } from '../../../../src/adapters/sandbox/host/HostExec.js';
import { NodeOutboundFiles } from '../../../../src/adapters/files/NodeOutboundFiles.js';
import type { ToolContext } from '../../../../src/ports/Tool.js';
import { testServices } from '../../../helpers.js';

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

  it('refuses a binary file with its size and detected type (#101)', async () => {
    const file = path.join(base, 'workspace', 'photo.jpg');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    );

    const out = await new WorkspaceReadTool(ws).run({ path: 'photo.jpg' });

    expect(out.isError).toBe(true);
    expect(out.content).toContain('JPEG image');
    expect(out.content).toContain('10 bytes');
    expect(out.content).toContain('cannot be read as text');
  });

  it('refuses a text file containing a NUL as binary (#101)', async () => {
    const file = path.join(base, 'workspace', 'odd.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('hello\u0000world', 'utf8'));

    const out = await new WorkspaceReadTool(ws).run({ path: 'odd.txt' });

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
  });
});

describe('workspace.edit (S41)', () => {
  const edit = () => new WorkspaceEditTool(ws);

  it('replaces one exact match and leaves the rest of the file alone', async () => {
    await new WorkspaceWriteTool(ws).run({
      path: 'src/app.ts',
      content: 'const a = 1;\nconst b = 2;\n',
      append: false,
    });

    const out = await edit().run({
      path: 'src/app.ts',
      old: 'const b = 2;',
      new: 'const b = 3;',
      all: false,
    });

    expect(out.isError).toBeFalsy();
    expect((await new WorkspaceReadTool(ws).run({ path: 'src/app.ts' })).content).toBe(
      'const a = 1;\nconst b = 3;\n',
    );
  });

  it('refuses an ambiguous match and says how many there are', async () => {
    await new WorkspaceWriteTool(ws).run({
      path: 'notes.md',
      content: 'todo\ntodo\ntodo\n',
      append: false,
    });

    const out = await edit().run({ path: 'notes.md', old: 'todo', new: 'done', all: false });

    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/matches 3 places/);
    expect(out.content).toMatch(/all: true/);
    // Nothing is changed.
    expect((await new WorkspaceReadTool(ws).run({ path: 'notes.md' })).content).toBe(
      'todo\ntodo\ntodo\n',
    );
  });

  it('replaces every match when asked to, and refuses text that is not there', async () => {
    await new WorkspaceWriteTool(ws).run({
      path: 'notes.md',
      content: 'todo\ntodo\ntodo\n',
      append: false,
    });

    const all = await edit().run({ path: 'notes.md', old: 'todo', new: 'done', all: true });
    expect(all.isError).toBeFalsy();
    expect((await new WorkspaceReadTool(ws).run({ path: 'notes.md' })).content).toBe(
      'done\ndone\ndone\n',
    );

    const missing = await edit().run({ path: 'notes.md', old: 'absent', new: 'x', all: false });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toMatch(/does not contain/);
  });

  it('reports a missing file and refuses a path outside the workspace', async () => {
    expect(await edit().run({ path: 'nope.md', old: 'a', new: 'b', all: false })).toMatchObject({
      isError: true,
    });
    await expect(
      edit().run({ path: '../outside.md', old: 'a', new: 'b', all: false }),
    ).rejects.toThrow(/outside/);
  });
});

describe('workspace.find (S41)', () => {
  const find = () => new WorkspaceFindTool(ws);

  beforeEach(async () => {
    const write = new WorkspaceWriteTool(ws);
    await write.run({ path: 'notes.md', content: 'the chestnut is here', append: false });
    await write.run({ path: 'docs/a.md', content: 'a chestnut', append: false });
    await write.run({ path: 'docs/b.txt', content: 'nothing', append: false });
    await write.run({ path: 'src/app.ts', content: 'const chestnut = 1;', append: false });
  });

  it('finds files by glob, matching the name or the whole path', async () => {
    await fs.promises.mkdir(path.join(base, 'workspace', 'src', 'deep'), { recursive: true });
    await fs.promises.writeFile(path.join(base, 'workspace', 'src', 'deep', 'c.md'), 'c');

    expect((await find().run({ path: '.', glob: '*.md', limit: 100 })).content).toBe(
      'docs/a.md\nnotes.md\nsrc/deep/c.md',
    );
    expect((await find().run({ path: '.', glob: 'src/**/*.ts', limit: 100 })).content).toBe(
      'src/app.ts',
    );
  });

  it('finds files by text, and by glob and text together', async () => {
    expect((await find().run({ path: '.', text: 'chestnut', limit: 100 })).content).toBe(
      ['docs/a.md', 'notes.md', 'src/app.ts'].join('\n'),
    );
    expect(
      (await find().run({ path: '.', glob: '*.md', text: 'chestnut', limit: 100 })).content,
    ).toBe(['docs/a.md', 'notes.md'].join('\n'));
  });

  it('says when nothing matched, and stops at the limit', async () => {
    expect((await find().run({ path: '.', text: 'no-such-text', limit: 100 })).content).toMatch(
      /No matches/,
    );

    const limited = await find().run({ path: '.', text: 'chestnut', limit: 2 });
    expect(limited.content.split('\n').length).toBe(3);
    expect(limited.content).toMatch(/stopped at 2/);
  });

  it('refuses an empty search and a missing folder, and keeps to the roots', async () => {
    expect(await find().run({ path: '.', limit: 100 })).toMatchObject({ isError: true });
    expect(await find().run({ path: 'nope', glob: '*.md', limit: 100 })).toMatchObject({
      isError: true,
    });
    await expect(find().run({ path: '../..', glob: '*', limit: 100 })).rejects.toThrow(/outside/);
  });
});

describe('workspace.exec', () => {
  const exec = (opts: Partial<{ defaultTimeoutSeconds: number }> = {}) => {
    const options = {
      defaultTimeoutSeconds: opts.defaultTimeoutSeconds ?? 20,
      maxTimeoutSeconds: 60,
      maxOutputBytes: 10_000,
    };
    return new WorkspaceExecTool(
      ws,
      new HostExec({ maxTimeoutMs: options.maxTimeoutSeconds * 1000 }),
      options,
    );
  };
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

  it('keeps head and tail of long output and saves the full log (S41)', async () => {
    const options = { defaultTimeoutSeconds: 20, maxTimeoutSeconds: 60, maxOutputBytes: 200 };
    const tool = new WorkspaceExecTool(
      ws,
      new HostExec({ maxTimeoutMs: options.maxTimeoutSeconds * 1000 }),
      options,
    );
    const out = await tool.run(
      {
        program: node,
        args: ['-e', 'process.stdout.write("A".repeat(500) + "MIDDLE" + "Z".repeat(500))'],
        cwd: '.',
      },
      ctx(),
    );

    expect(out.isError).toBe(false);
    // 100 bytes of head and 100 of tail keep the cap, with a marker where the middle was.
    expect(out.content).toMatch(/^exit code 0\nA{100}\n\[/);
    expect(out.content).toMatch(/\]\nZ{100}$/);
    expect(out.content).toContain('bytes omitted');
    expect(out.content).not.toContain('MIDDLE');

    const logPath = (out.data as { logPath?: string }).logPath;
    expect(logPath).toBeTruthy();
    expect(logPath!.split(path.sep).join('/')).toContain('/sessions/s/exec-t-1.log');
    const log = fs.readFileSync(logPath!, 'utf8');
    expect(log).toContain('MIDDLE');
    expect(log).toHaveLength(1006);
  });

  it('gives each over-cap command its own log (S41 review)', async () => {
    const options = { defaultTimeoutSeconds: 20, maxTimeoutSeconds: 60, maxOutputBytes: 200 };
    const tool = new WorkspaceExecTool(
      ws,
      new HostExec({ maxTimeoutMs: options.maxTimeoutSeconds * 1000 }),
      options,
    );
    const call = () =>
      tool.run(
        { program: node, args: ['-e', 'process.stdout.write("A".repeat(500))'], cwd: '.' },
        ctx(),
      );

    const first = await call();
    const second = await call();
    const a = (first.data as { logPath?: string }).logPath;
    const b = (second.data as { logPath?: string }).logPath;

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a!, 'utf8')).toHaveLength(500);
    expect(fs.readFileSync(b!, 'utf8')).toHaveLength(500);
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

describe('Handoff reads and workspace.send (S33)', () => {
  let handoff: string;
  beforeEach(() => {
    handoff = path.join(base, 'handoff');
    fs.mkdirSync(handoff, { recursive: true });
  });

  const readRoot = () => new WorkspaceRoot(path.join(base, 'workspace'), [handoff]);
  const outbox = () => path.join(base, 'outbox');
  const send = () => new WorkspaceSendTool(readRoot(), new NodeOutboundFiles(outbox()));

  it('reads a handoff file by relative name and by absolute path', async () => {
    fs.writeFileSync(path.join(handoff, 'report.txt'), 'hello');

    expect(fs.readFileSync(await readRoot().resolveRead('report.txt'), 'utf8')).toBe('hello');
    expect(
      fs.readFileSync(await readRoot().resolveRead(path.join(handoff, 'report.txt')), 'utf8'),
    ).toBe('hello');
  });

  it('keeps the workspace readable and refuses anything outside both folders', async () => {
    fs.mkdirSync(path.join(base, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(base, 'workspace', 'notes.md'), 'notes');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');

    expect(fs.readFileSync(await readRoot().resolveRead('notes.md'), 'utf8')).toBe('notes');
    await expect(readRoot().resolveRead(path.join(base, 'secret.txt'))).rejects.toThrow(/outside/);
    await expect(readRoot().resolveRead('../secret.txt')).rejects.toThrow(/outside/);
  });

  it('attaches a handoff file with its media type', async () => {
    const file = path.join(handoff, 'report.pdf');
    fs.writeFileSync(file, 'pdf');

    const output = await send().run({ path: file }, ctx());

    expect(output.isError).toBeFalsy();
    expect(output.data).toEqual({
      files: [
        {
          path: path.join(outbox(), 'report.pdf'),
          name: 'report.pdf',
          mediaType: 'application/pdf',
        },
      ],
    });
  });

  it('attaches a workspace file by relative path and keeps a caption', async () => {
    fs.mkdirSync(path.join(base, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(base, 'workspace', 'photo.png'), 'png');

    const output = await send().run({ path: 'photo.png', caption: 'The photo' }, ctx());

    expect(output.data).toMatchObject({
      files: [{ name: 'photo.png', mediaType: 'image/png', caption: 'The photo' }],
    });
  });

  it('delivers a binary file byte for byte (S41)', async () => {
    // A PNG header and a few bytes that are not valid UTF-8.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    fs.mkdirSync(path.join(base, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(base, 'workspace', 'photo.png'), bytes);

    const output = await send().run({ path: 'photo.png' }, ctx());

    const staged = (output.data as { files: { path: string }[] }).files[0]!.path;
    expect(fs.readFileSync(staged).equals(bytes)).toBe(true);
    expect(staged.endsWith('photo.png')).toBe(true);
  });

  it('refuses a file outside the roots and reports one that is missing', async () => {
    const outside = path.join(base, 'secret.txt');
    fs.writeFileSync(outside, 'secret');

    await expect(send().run({ path: outside }, ctx())).rejects.toThrow(/outside/);
    expect(await send().run({ path: 'missing.pdf' }, ctx())).toMatchObject({ isError: true });
  });
});
