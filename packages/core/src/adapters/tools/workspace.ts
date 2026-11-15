import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

/**
 * The folder the file and exec tools are confined to until the workspace container exists (F08).
 * Every path is resolved inside it; `..`, absolute paths and symlinks pointing outside are refused.
 */
export class WorkspaceRoot {
  private real?: string;

  constructor(readonly dir: string) {}

  /** The real path of the root, created on first use. */
  async root(): Promise<string> {
    if (!this.real) {
      await fs.mkdir(this.dir, { recursive: true });
      this.real = await fs.realpath(this.dir);
    }
    return this.real;
  }

  /** Resolves a workspace-relative path; throws if it would leave the workspace. */
  async resolve(relative: string): Promise<string> {
    const root = await this.root();
    if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
      throw new Error(`"${relative}" is absolute; use a path relative to the workspace`);
    }
    const target = path.resolve(root, relative);
    if (!inside(root, target)) throw new Error(`"${relative}" is outside the workspace`);
    // Follow symlinks on the deepest existing part of the path.
    let existing = target;
    while (!(await exists(existing))) existing = path.dirname(existing);
    const realExisting = await fs.realpath(existing);
    if (!inside(root, realExisting)) {
      throw new Error(`"${relative}" leads outside the workspace through a link`);
    }
    return path.join(realExisting, path.relative(existing, target));
  }

  /** A path for display, relative to the root. */
  display(absolute: string): string {
    return (
      path
        .relative(this.real ?? this.dir, absolute)
        .split(path.sep)
        .join('/') || '.'
    );
  }
}

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

const MAX_READ_BYTES = 1_000_000;

const readInput = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace'),
});

export class WorkspaceReadTool extends BaseTool<typeof readInput> {
  readonly name = 'workspace.read';
  readonly description = 'Read a text file from the workspace folder.';
  readonly input = readInput;
  readonly effect = 'read' as const;
  constructor(private readonly ws: WorkspaceRoot) {
    super();
  }
  async run({ path: p }: z.infer<typeof readInput>): Promise<ToolOutput> {
    const file = await this.ws.resolve(p);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat) return { content: `No such file: ${p}`, isError: true };
    if (!stat.isFile()) return { content: `${p} is not a file`, isError: true };
    if (stat.size > MAX_READ_BYTES) {
      return {
        content: `${p} is ${stat.size} bytes; the limit is ${MAX_READ_BYTES}`,
        isError: true,
      };
    }
    return { content: await fs.readFile(file, 'utf8'), data: { bytes: stat.size } };
  }
}

const writeInput = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace'),
  content: z.string(),
  append: z.boolean().default(false),
});

export class WorkspaceWriteTool extends BaseTool<typeof writeInput> {
  readonly name = 'workspace.write';
  readonly description =
    'Write (or append to) a text file in the workspace folder, creating folders as needed.';
  readonly input = writeInput;
  readonly effect = 'write_local' as const;
  constructor(private readonly ws: WorkspaceRoot) {
    super();
  }
  async run({ path: p, content, append }: z.infer<typeof writeInput>): Promise<ToolOutput> {
    const file = await this.ws.resolve(p);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await (append ? fs.appendFile(file, content, 'utf8') : fs.writeFile(file, content, 'utf8'));
    return {
      content: `${append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(content)} bytes to ${this.ws.display(file)}`,
    };
  }
}

const listInput = z.object({
  path: z.string().default('.').describe('Folder, relative to the workspace'),
});

export class WorkspaceListTool extends BaseTool<typeof listInput> {
  readonly name = 'workspace.list';
  readonly description = 'List the files and folders in a workspace folder.';
  readonly input = listInput;
  readonly effect = 'read' as const;
  constructor(private readonly ws: WorkspaceRoot) {
    super();
  }
  async run({ path: p }: z.infer<typeof listInput>): Promise<ToolOutput> {
    const dir = await this.ws.resolve(p);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return { content: `No such folder: ${p}`, isError: true };
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { content: lines.length ? lines.join('\n') : '(empty)' };
  }
}

export interface ExecOptions {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
}

const execInput = z.object({
  program: z.string().min(1).describe('The program to run, e.g. "python3" or "git"'),
  args: z.array(z.string()).default([]).describe('Arguments, one per item; no shell is involved'),
  cwd: z.string().default('.').describe('Working folder, relative to the workspace'),
  timeoutSeconds: z.number().int().positive().optional(),
});

/**
 * workspace.exec: runs one program with arguments (no shell, so no `;`, pipes or globbing), with its
 * working folder in the workspace, a timeout, an output cap, and a kill on Stop. Until F08 the program
 * itself runs with the core process's permissions (decision Q1).
 */
export class WorkspaceExecTool extends BaseTool<typeof execInput> {
  readonly name = 'workspace.exec';
  readonly description =
    'Run one program with arguments in the workspace folder and return its exit code and output. ' +
    'No shell: pass each argument separately, and use no pipes, redirects or ";".';
  readonly input = execInput;
  readonly effect = 'write_local' as const;

  constructor(
    private readonly ws: WorkspaceRoot,
    private readonly options: ExecOptions,
  ) {
    super();
  }

  async run(args: z.infer<typeof execInput>, ctx: ToolContext): Promise<ToolOutput> {
    const cwd = await this.ws.resolve(args.cwd);
    const timeoutS = Math.min(
      args.timeoutSeconds ?? this.options.defaultTimeoutSeconds,
      this.options.maxTimeoutSeconds,
    );
    return new Promise<ToolOutput>((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const child = spawn(args.program, args.args, {
        cwd,
        shell: false,
        windowsHide: true,
        signal: ctx.signal,
        timeout: timeoutS * 1000,
        killSignal: 'SIGKILL',
        env: { PATH: process.env.PATH ?? '', HOME: cwd, LANG: 'C.UTF-8' },
      });
      const collect = (b: Buffer) => {
        if (bytes >= this.options.maxOutputBytes) return void (truncated = true);
        chunks.push(b.subarray(0, this.options.maxOutputBytes - bytes));
        bytes += b.length;
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let failure: string | undefined;
      child.on('error', (error: NodeJS.ErrnoException) => {
        // No process was started: answer now. Otherwise wait for 'close', so the process has really
        // exited (and released its working folder) before the tool returns.
        if (error.code === 'ENOENT') {
          resolve({ content: `Program not found: ${args.program}`, isError: true });
          return;
        }
        failure = error.name === 'AbortError' ? 'Stopped' : error.message;
      });
      child.on('close', (code, signal) => {
        if (failure) {
          resolve({ content: failure, isError: true, data: { exitCode: code, signal } });
          return;
        }
        const output =
          Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : '');
        const timedOut = signal === 'SIGKILL' && !ctx.signal.aborted;
        const status = timedOut
          ? `timed out after ${timeoutS}s`
          : signal
            ? `killed (${signal})`
            : `exit code ${code}`;
        resolve({
          content: `${status}\n${output}`.trimEnd(),
          isError: code !== 0,
          data: { exitCode: code, signal, timedOut },
        });
      });
    });
  }
}
