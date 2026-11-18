import path from 'node:path';
import { z } from 'zod/v4';
import type { ExecEvent, SandboxExec, SandboxFiles } from '../../../ports/SandboxDriver.js';
import type { OutboundFiles } from '../../../ports/OutboundFiles.js';
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

const editInput = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace'),
  old: z.string().min(1).describe('The exact text to replace, whitespace and indentation included'),
  new: z.string().describe('The replacement text'),
  all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of refusing an ambiguous match'),
});

/**
 * workspace.edit changes a file by exact string replacement, like a coding agent: a missing or
 * ambiguous match is refused rather than guessed at, so a wrong edit cannot silently hit the wrong
 * place.
 */
export class WorkspaceEditTool extends BaseTool<typeof editInput> {
  readonly name = 'workspace.edit';
  readonly description =
    'Replace an exact piece of text in a workspace file. The text must appear exactly once unless ' +
    'all is true; include surrounding lines when it is not unique.';
  readonly input = editInput;
  readonly effect = 'write_local' as const;
  override readonly target = 'workspace' as const;
  constructor(private readonly files: SandboxFiles) {
    super();
  }
  async run({
    path: p,
    old,
    new: replacement,
    all,
  }: z.infer<typeof editInput>): Promise<ToolOutput> {
    const file = await this.files.resolve(p);
    const stat = await this.files.stat(file);
    if (!stat) return { content: `No such file: ${p}`, isError: true };
    if (!stat.isFile) return { content: `${p} is not a file`, isError: true };
    const content = await this.files.read(file);
    const count = occurrences(content, old);
    if (count === 0) {
      return { content: `${p} does not contain that text.`, isError: true };
    }
    if (count > 1 && !all) {
      return {
        content:
          `That text matches ${count} places in ${p}; include more surrounding lines to pick one, ` +
          'or set all: true to replace every one.',
        isError: true,
      };
    }
    const next = all ? content.split(old).join(replacement) : content.replace(old, replacement);
    await this.files.write(file, next, { append: false });
    const replaced = all ? count : 1;
    return {
      content: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${this.files.display(file)}.`,
      data: { replaced },
    };
  }
}

/** How many times `needle` appears in `text`, without overlapping itself. */
function occurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count++;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
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

const findInput = z.object({
  path: z
    .string()
    .default('.')
    .describe('Folder to search, relative to the workspace or the handoff folder'),
  glob: z
    .string()
    .optional()
    .describe('Glob for the name or path, e.g. "*.md" or "src/**/*.ts"; ** crosses folders'),
  text: z.string().optional().describe('Only files that contain this exact text'),
  limit: z.number().int().min(1).max(500).default(100).describe('Stop after this many files'),
});

/** Files bigger than this are not read for a text search; use list and read instead. */
const MAX_FIND_BYTES = 1_000_000;
const SKIP_FOLDERS = new Set(['.git', 'node_modules']);

/**
 * workspace.find looks for files by name (glob) and/or by content (text) inside the roots. It is a
 * read: the results are paths, and reading one is a separate call.
 */
export class WorkspaceFindTool extends BaseTool<typeof findInput> {
  readonly name = 'workspace.find';
  readonly description =
    'Find files in the workspace or handoff folder by glob, by text they contain, or both. ' +
    'Returns matching paths, one per line.';
  readonly input = findInput;
  readonly effect = 'read' as const;
  override readonly target = 'workspace' as const;
  constructor(private readonly files: SandboxFiles) {
    super();
  }

  async run({ path: root, glob, text, limit }: z.infer<typeof findInput>): Promise<ToolOutput> {
    if (!glob && !text) {
      return { content: 'Give a glob, a text, or both.', isError: true };
    }
    const dir = await this.files.resolveRead(root);
    const entries = await this.files.list(dir);
    if (!entries) return { content: `No such folder: ${root}`, isError: true };
    const matches = glob ? globToRegExp(glob) : undefined;
    const found: string[] = [];
    let stopped = false;
    const walk = async (absolute: string, relative: string): Promise<void> => {
      if (stopped) return;
      const listing = await this.files.list(absolute);
      for (const entry of listing ?? []) {
        if (stopped) return;
        const childAbsolute = `${absolute}/${entry.name}`;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.directory) {
          if (SKIP_FOLDERS.has(entry.name)) continue;
          await walk(childAbsolute, childRelative);
          continue;
        }
        if (matches && !matches.test(childRelative) && !matches.test(entry.name)) continue;
        if (text !== undefined) {
          const stat = await this.files.stat(childAbsolute);
          if (!stat?.isFile || stat.size > MAX_FIND_BYTES) continue;
          const content = await this.files.read(childAbsolute).catch(() => undefined);
          if (content === undefined || !content.includes(text)) continue;
        }
        found.push(childRelative);
        if (found.length >= limit) {
          stopped = true;
          return;
        }
      }
    };
    await walk(dir, '');
    if (!found.length) return { content: 'No matches.', data: { matches: 0 } };
    found.sort();
    const lines = [...found, ...(stopped ? [`[stopped at ${limit} matches]`] : [])];
    return { content: lines.join('\n'), data: { matches: found.length } };
  }
}

/** A glob for a workspace path: `*` stays in one folder, `**` crosses them, `?` is one character. */
function globToRegExp(glob: string): RegExp {
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        body += '.*';
        i++;
        if (glob[i + 1] === '/') {
          body += '\\/?';
          i++;
        }
      } else {
        body += '[^/]*';
      }
    } else if (char === '?') {
      body += '[^/]';
    } else {
      body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${body}$`);
}

const sendInput = z.object({
  path: z.string().min(1).describe('File path in the workspace or the handoff folder'),
  caption: z.string().max(1024).optional().describe('A short caption for the recipient'),
});

/** Telegram's bot upload limit is 50 MB; stay under it. */
const MAX_SEND_BYTES = 48 * 1024 * 1024;

/**
 * workspace.send attaches a file to the reply (F06, S33). The sandbox may be a container `core`
 * cannot read, so the bytes come through the files port and are staged on core's disk for the
 * channel; a binary file arrives byte for byte.
 */
export class WorkspaceSendTool extends BaseTool<typeof sendInput> {
  readonly name = 'workspace.send';
  readonly description =
    'Attach a file from the workspace or the handoff folder to your reply. Telegram sends it as a ' +
    'document. Use it after creating or receiving the file.';
  readonly input = sendInput;
  /** Sending the owner a file is an outside action (X4); the shipped rule allows it. */
  readonly effect = 'external' as const;
  override readonly target = 'workspace' as const;

  constructor(
    private readonly files: SandboxFiles,
    private readonly outbound: OutboundFiles,
  ) {
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
    const staged = await this.outbound.stage(name, await this.files.readBytes(file));
    return {
      content: `Attached ${name}.`,
      data: {
        files: [
          {
            path: staged,
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

/** The most of a command's output kept in memory for the session log; the rest is dropped. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
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
    private readonly exec: SandboxExec,
    private readonly options: ExecOptions,
  ) {
    super();
  }

  async run(args: z.infer<typeof execInput>, ctx: ToolContext): Promise<ToolOutput> {
    const cwd = await this.files.resolve(args.cwd);
    const timeoutS = Math.min(
      args.timeoutSeconds ?? this.options.defaultTimeoutSeconds,
      this.options.maxTimeoutSeconds,
      Math.floor(this.exec.maxTimeoutMs / 1000),
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let logCapped = false;
    let exit: Extract<ExecEvent, { type: 'exit' }> | undefined;
    try {
      for await (const event of this.exec.run(
        { program: args.program, args: args.args, cwd, timeoutMs: timeoutS * 1000 },
        ctx.signal,
      )) {
        if (event.type === 'exit') {
          exit = event;
          continue;
        }
        if (bytes >= MAX_LOG_BYTES) {
          logCapped = true;
          continue;
        }
        chunks.push(Buffer.from(event.text));
        bytes += Buffer.byteLength(event.text);
      }
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
    if (!exit) return { content: 'The command ended without an exit code', isError: true };
    const full = Buffer.concat(chunks);
    // Long output keeps its head and tail for the model; the whole of it goes to the session folder.
    let output: string;
    let logPath: string | undefined;
    if (full.length > this.options.maxOutputBytes) {
      const log = await this.saveLog(ctx, full, logCapped);
      logPath = log.path;
      const head = Math.floor(this.options.maxOutputBytes / 2);
      const tail = this.options.maxOutputBytes - head;
      const omitted = full.length - head - tail;
      output =
        full.subarray(0, head).toString('utf8') +
        `\n[... ${omitted} bytes omitted; the full output is in ${this.files.display(log.path)}` +
        `${logCapped ? ', which itself was capped' : ''} ...]\n` +
        full.subarray(full.length - tail).toString('utf8');
    } else {
      output = full.toString('utf8');
    }
    const status = exit.timedOut
      ? `timed out after ${timeoutS}s`
      : exit.signal
        ? `killed (${exit.signal})`
        : `exit code ${exit.code}`;
    return {
      content: `${status}\n${output}`.trimEnd(),
      isError: exit.code !== 0,
      data: {
        exitCode: exit.code,
        signal: exit.signal,
        timedOut: exit.timedOut,
        ...(logPath && { logPath }),
      },
    };
  }

  /** The whole output, in `sessions/<sessionId>/`, so the owner can read what the model could not. */
  private async saveLog(
    ctx: ToolContext,
    output: Buffer,
    capped: boolean,
  ): Promise<{ path: string }> {
    const file = await this.files.resolve(`sessions/${ctx.sessionId}/exec-${ctx.turnId}.log`);
    const text =
      output.toString('utf8') +
      (capped ? `\n[the log itself was capped at ${MAX_LOG_BYTES} bytes]` : '');
    await this.files.write(file, text, { append: false });
    return { path: file };
  }
}
