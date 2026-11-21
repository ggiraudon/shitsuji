import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry, FileStat, SandboxFiles } from '../../../ports/SandboxDriver.js';

/**
 * The host driver's files: the workspace folder, and read-only roots such as the handoff folder
 * (decision T2, Q1). Every path is resolved inside them; `..`, absolute paths and symlinks pointing
 * outside are refused. This is the code that moves into `sandboxd` with the `shitsuji` driver.
 */
export class WorkspaceRoot implements SandboxFiles {
  private real?: string;

  constructor(
    readonly dir: string,
    /** Extra folders the read tools may reach, e.g. the handoff folder. Never writable. */
    private readonly readDirs: readonly string[] = [],
  ) {}

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

  /**
   * Resolves a path for reading: the workspace, then the handoff folder. An absolute path is allowed
   * only inside one of them (the gateway gives the agent absolute handoff paths, S33).
   */
  async resolveRead(input: string): Promise<string> {
    if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
      return this.resolveAbsoluteRead(input);
    }
    let workspacePath: string | undefined;
    try {
      workspacePath = await this.resolve(input);
      if (await exists(workspacePath)) return workspacePath;
    } catch {
      // not in the workspace; the read folders may still have it
    }
    for (const dir of this.readDirs) {
      try {
        const candidate = await new WorkspaceRoot(dir).resolve(input);
        if (await exists(candidate)) return candidate;
      } catch {
        // try the next read folder
      }
    }
    if (workspacePath) return workspacePath;
    throw new Error(`"${input}" is outside the workspace and the handoff folder`);
  }

  private async resolveAbsoluteRead(input: string): Promise<string> {
    const roots = [
      await this.root(),
      ...(await Promise.all(this.readDirs.map((dir) => new WorkspaceRoot(dir).root()))),
    ];
    const target = path.resolve(input);
    const root = roots.find((candidate) => inside(candidate, target));
    if (!root) throw new Error(`"${input}" is outside the workspace and the handoff folder`);
    let existing = target;
    while (!(await exists(existing))) existing = path.dirname(existing);
    const realExisting = await fs.realpath(existing);
    if (!roots.some((candidate) => inside(candidate, realExisting))) {
      throw new Error(`"${input}" leads outside the workspace through a link`);
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

  read(absolute: string): Promise<string> {
    return fs.readFile(absolute, 'utf8');
  }

  readBytes(absolute: string): Promise<Uint8Array> {
    return fs.readFile(absolute);
  }

  async stat(absolute: string): Promise<FileStat | undefined> {
    const stat = await fs.stat(absolute).catch(() => undefined);
    return stat && { size: stat.size, isFile: stat.isFile() };
  }

  async write(absolute: string, content: string, options: { append: boolean }): Promise<void> {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await (options.append
      ? fs.appendFile(absolute, content, 'utf8')
      : fs.writeFile(absolute, content, 'utf8'));
  }

  async writeBytes(absolute: string, content: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  async mkdir(absolute: string): Promise<void> {
    await fs.mkdir(absolute, { recursive: true });
  }

  async list(absolute: string): Promise<FileEntry[] | undefined> {
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => undefined);
    return entries?.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
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
