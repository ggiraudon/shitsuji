import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ListFilesReply,
  MkdirReply,
  MoveFileRequest,
  MoveFileReply,
  ReadFileReply,
  SandboxRoot,
  StatFileReply,
  WriteFileReply,
  WriteFileRequest,
} from '@shitsuji/sandbox-protocol';
import { alreadyExists, invalidRequest } from './errors.js';
import type { SandboxPaths } from './paths.js';

/**
 * The files API inside one sandbox. Every operation takes the model's path and resolves it through
 * SandboxPaths in the same call, so confinement and the I/O cannot drift apart.
 */
export class SandboxFilesService {
  constructor(private readonly paths: SandboxPaths) {}

  async read(
    root: SandboxRoot,
    relative: string,
    encoding: 'text' | 'base64',
  ): Promise<ReadFileReply> {
    const file = await this.paths.resolveExisting(root, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw invalidRequest(`"${relative}" is not a file.`);
    const data = await fs.readFile(file);
    return {
      encoding,
      content: encoding === 'base64' ? data.toString('base64') : data.toString('utf8'),
      bytes: data.length,
    };
  }

  async write(root: SandboxRoot, request: WriteFileRequest): Promise<WriteFileReply> {
    const file = await this.paths.resolveForWrite(root, request.path, request.createParents);
    const data =
      request.encoding === 'base64'
        ? Buffer.from(request.content, 'base64')
        : Buffer.from(request.content, 'utf8');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await (request.append ? fs.appendFile(file, data) : fs.writeFile(file, data));
    return { bytes: data.length };
  }

  async list(root: SandboxRoot, relative: string): Promise<ListFilesReply> {
    const dir = await this.paths.resolveExisting(root, relative);
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw invalidRequest(`"${relative}" is not a folder.`);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const described = await Promise.all(
      entries.map(async (entry) => {
        const entryStat = await fs.lstat(path.join(dir, entry.name)).catch(() => undefined);
        return {
          name: entry.name,
          directory: entry.isDirectory(),
          size: entryStat?.size ?? 0,
        };
      }),
    );
    return { entries: described.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async stat(root: SandboxRoot, relative: string): Promise<StatFileReply> {
    let file: string;
    try {
      file = await this.paths.resolveExisting(root, relative);
    } catch (error) {
      if ((error as { code?: string }).code === 'not_found') return { exists: false };
      throw error;
    }
    const stat = await fs.stat(file);
    return {
      exists: true,
      size: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async mkdir(root: SandboxRoot, relative: string): Promise<MkdirReply> {
    const dir = await this.paths.resolveForWrite(root, relative, true);
    await fs.mkdir(dir, { recursive: true });
    return { created: true };
  }

  async move(root: SandboxRoot, request: MoveFileRequest): Promise<MoveFileReply> {
    const from = await this.paths.resolveExisting(root, request.from);
    const to = await this.paths.resolveForWrite(root, request.to, true);
    if (request.from === request.to) return { moved: true };
    const existing = await fs.lstat(to).catch(() => undefined);
    if (existing && !request.overwrite) throw alreadyExists(request.to);
    await fs.mkdir(path.dirname(to), { recursive: true });
    if (existing?.isDirectory()) await fs.rm(to, { recursive: true, force: true });
    else if (existing) await fs.rm(to, { force: true });
    try {
      await fs.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // A mount boundary (`/workspace` and `/handoff` are different volumes): copy, then remove.
      await fs.copyFile(from, to);
      await fs.unlink(from);
    }
    return { moved: true };
  }
}
