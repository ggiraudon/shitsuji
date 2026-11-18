import fs from 'node:fs/promises';
import path from 'node:path';
import { isRelativePath, type SandboxRoot } from '@shitsuji/sandbox-protocol';
import { invalidRequest, notFound, outsideRoot, readOnly } from './errors.js';

export interface RootSpec {
  dir: string;
  /** The handoff folder is shared with core; the sandbox only reads it. */
  readOnly?: boolean;
}

/**
 * Turns the model's relative path into a real path inside a root, and refuses anything that leaves
 * it (F08, S45). The check is on the resolved path, not the string: `..`, absolute paths and links
 * are all resolved first, so a symlink planted inside the workspace cannot reach a host file. The
 * check and the file operation happen in the same request, inside the daemon.
 */
export class SandboxPaths {
  private readonly real = new Map<SandboxRoot, string>();

  constructor(private readonly roots: Record<SandboxRoot, RootSpec>) {}

  /** Creates the roots (compose mounts them; tests use temp folders) and remembers their real paths. */
  async start(): Promise<void> {
    for (const root of Object.keys(this.roots) as SandboxRoot[]) {
      const spec = this.roots[root]!;
      await fs.mkdir(spec.dir, { recursive: true });
      this.real.set(root, await fs.realpath(spec.dir));
    }
  }

  isReadOnly(root: SandboxRoot): boolean {
    return this.roots[root]?.readOnly ?? false;
  }

  /** The real path of a file or folder that must exist inside the root. */
  async resolveExisting(root: SandboxRoot, relative: string): Promise<string> {
    const target = this.join(root, relative);
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw notFound(`"${relative}" does not exist.`);
      }
      if (code === 'ELOOP') throw outsideRoot(relative);
      throw error;
    }
    this.assertInside(root, real, relative);
    return real;
  }

  /**
   * The real path to write to. The target may not exist; every existing part of it is resolved, and
   * a dangling link is refused because it cannot be proven to stay inside.
   */
  async resolveForWrite(
    root: SandboxRoot,
    relative: string,
    createParents: boolean,
  ): Promise<string> {
    if (this.isReadOnly(root)) throw readOnly(root);
    const target = this.join(root, relative);
    let existing = path.dirname(target);
    while (!(await lstatSafe(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) throw outsideRoot(relative);
      existing = parent;
    }
    let realExisting: string;
    try {
      realExisting = await fs.realpath(existing);
    } catch {
      // A dangling link in the path: there is no way to prove where a write would land.
      throw outsideRoot(relative);
    }
    this.assertInside(root, realExisting, relative);
    const resolved = path.join(realExisting, path.relative(existing, target));

    const targetStat = await lstatSafe(target);
    if (targetStat) {
      let realTarget: string;
      try {
        realTarget = await fs.realpath(target);
      } catch {
        throw outsideRoot(relative);
      }
      this.assertInside(root, realTarget, relative);
      return realTarget;
    }
    if (!createParents && !(await lstatSafe(path.dirname(target)))) {
      throw notFound(`The folder for "${relative}" does not exist.`);
    }
    return resolved;
  }

  private join(root: SandboxRoot, relative: string): string {
    if (!isRelativePath(relative)) throw outsideRoot(relative);
    const normalized = path.posix.normalize(relative);
    if (normalized === '..' || normalized.startsWith('../')) throw outsideRoot(relative);
    const realRoot = this.real.get(root);
    if (!realRoot) throw new Error('SandboxPaths.start() has not run.');
    const target = path.resolve(realRoot, normalized);
    if (!inside(realRoot, target)) throw outsideRoot(relative);
    return target;
  }

  private assertInside(root: SandboxRoot, candidate: string, relative: string): void {
    const realRoot = this.real.get(root);
    if (!realRoot || !inside(realRoot, candidate)) throw outsideRoot(relative);
  }
}

/** `candidate` is `root` or below it; `..` is excluded on purpose. */
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function lstatSafe(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return undefined;
  }
}

/** A quick check used by the routes for a folder that could not be a file. */
export const notADirectory = (relative: string) => invalidRequest(`"${relative}" is not a folder.`);
