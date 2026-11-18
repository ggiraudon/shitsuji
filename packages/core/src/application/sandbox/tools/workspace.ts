import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod/v4';
import type { SandboxFiles } from '../../../ports/SandboxDriver.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../ports/Tool.js';

const MAX_READ_BYTES = 1_000_000;

const readInput = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace'),
});

export class WorkspaceReadTool extends BaseTool<typeof readInput> {
  readonly name = 'workspace.read';
  readonly description = 'Read a text file from the workspace or the handoff folder.';
  readonly input = readInput;
  readonly effect = 'read' as const;
  override readonly target = 'workspace' as const;
  constructor(private readonly files: SandboxFiles) {
    super();
  }
  async run({ path: p }: z.infer<typeof readInput>): Promise<ToolOutput> {
    const file = await this.files.resolveRead(p);
    const stat = await this.files.stat(file);
    if (!stat) return { content: `No such file: ${p}`, isError: true };
    if (!stat.isFile) return { content: `${p} is not a file`, isError: true };
    if (stat.size > MAX_READ_BYTES) {
      return {
        content: `${p} is ${stat.size} bytes; the limit is ${MAX_READ_BYTES}`,
        isError: true,
      };
    }
    return { content: await this.files.read(file), data: { bytes: stat.size } };
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
  override readonly target = 'workspace' as const;
  constructor(private readonly files: SandboxFiles) {
    super();
  }
  async run({ path: p, content, append }: z.infer<typeof writeInput>): Promise<ToolOutput> {
    const file = await this.files.resolve(p);
    await this.files.write(file, content, { append });
    return {
      content: `${append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(content)} bytes to ${this.files.display(file)}`,
    };
  }
}

const listInput = z.object({
  path: z.string().default('.').describe('Folder, relative to the workspace'),
});

export class WorkspaceListTool extends BaseTool<typeof listInput> {
  readonly name = 'workspace.list';
  readonly description = 'List the files and folders in a workspace or handoff folder.';
  readonly input = listInput;
  readonly effect = 'read' as const;
  override readonly target = 'workspace' as const;
  constructor(private readonly files: SandboxFiles) {
    super();
  }
  async run({ path: p }: z.infer<typeof listInput>): Promise<ToolOutput> {
    const dir = await this.files.resolveRead(p);
    const entries = await this.files.list(dir);
    if (!entries) return { content: `No such folder: ${p}`, isError: true };
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => (entry.directory ? `${entry.name}/` : entry.name));
    return { content: lines.length ? lines.join('\n') : '(empty)' };
  }
}

const sendInput = z.object({
  path: z.string().min(1).describe('File path in the workspace or the handoff folder'),
  caption: z.string().max(1024).optional().describe('A short caption for the recipient'),
});

/** Telegram's bot upload limit is 50 MB; stay under it. */
const MAX_SEND_BYTES = 48 * 1024 * 1024;

/**
 * workspace.send attaches a file to the reply (F06, S33). It only reads (the channel does the sending),
 * so it stays inside the fixed trust policy; the path is confined to the workspace and handoff roots.
 */
export class WorkspaceSendTool extends BaseTool<typeof sendInput> {
  readonly name = 'workspace.send';
  readonly description =
    'Attach a file from the workspace or the handoff folder to your reply. Telegram sends it as a ' +
    'document. Use it after creating or receiving the file.';
  readonly input = sendInput;
  readonly effect = 'read' as const;
  override readonly target = 'workspace' as const;

  constructor(private readonly files: SandboxFiles) {
    super();
  }

  async run(
    { path: p, caption }: z.infer<typeof sendInput>,
    _ctx: ToolContext,
  ): Promise<ToolOutput> {
    const file = await this.files.resolveRead(p);
    const stat = await this.files.stat(file);
    if (!stat) return { content: `No such file: ${p}`, isError: true };
    if (!stat.isFile) return { content: `${p} is not a file`, isError: true };
    if (stat.size > MAX_SEND_BYTES) {
      return {
        content: `${p} is ${stat.size} bytes; the limit is ${MAX_SEND_BYTES}`,
        isError: true,
      };
    }
    const name = path.basename(file);
    return {
      content: `Attached ${name}.`,
      data: {
        files: [
          {
            path: file,
            name,
            mediaType: mediaTypeOf(name),
            ...(caption ? { caption } : {}),
          },
        ],
      },
    };
  }
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
};

function mediaTypeOf(name: string): string {
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
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
 * working folder in the workspace, a timeout, an output cap, and a kill on Stop. The program runs in
 * the sandbox the driver opened; the `host` driver means the core process itself (decision Q1).
 */
export class WorkspaceExecTool extends BaseTool<typeof execInput> {
  readonly name = 'workspace.exec';
  readonly description =
    'Run one program with arguments in the workspace folder and return its exit code and output. ' +
    'No shell: pass each argument separately, and use no pipes, redirects or ";".';
  readonly input = execInput;
  readonly effect = 'write_local' as const;
  override readonly target = 'workspace' as const;

  constructor(
    private readonly files: SandboxFiles,
    private readonly options: ExecOptions,
  ) {
    super();
  }

  async run(args: z.infer<typeof execInput>, ctx: ToolContext): Promise<ToolOutput> {
    const cwd = await this.files.resolve(args.cwd);
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
