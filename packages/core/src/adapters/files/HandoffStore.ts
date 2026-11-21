import fs from 'node:fs/promises';
import path from 'node:path';

/** A file stored in the handoff folder, ready to be named to the agent. */
export interface HandoffFile {
  /** The stored name (sanitized, possibly suffixed to stay unique). */
  name: string;
  /** The absolute path the agent can read. */
  path: string;
  /** The file's size in bytes, as saved. */
  size: number;
}

/**
 * Where channel attachments land before the workspace sandbox exists (decision T2): `<dataDir>/handoff`,
 * next to the workspace folder. Names are made safe and never leave the folder; an existing name gets a
 * short suffix instead of overwriting (F06, S33).
 */
export class HandoffStore {
  constructor(
    /** The handoff folder, `<dataDir>/handoff`; it is created on the first save. */
    readonly dir: string,
  ) {}

  /** Writes the bytes under a safe, unique name and returns where they landed. */
  async save(name: string, data: Uint8Array): Promise<HandoffFile> {
    await fs.mkdir(this.dir, { recursive: true });
    const base = safeName(name);
    let file = path.join(this.dir, base);
    let suffix = 1;
    while (await exists(file)) file = path.join(this.dir, withSuffix(base, suffix++));
    await fs.writeFile(file, data, { flag: 'wx' });
    return { name: path.basename(file), path: file, size: data.byteLength };
  }
}

/** A bare file name inside the handoff folder; no directories, no leading dots. */
export function safeName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return base || 'file';
}

function withSuffix(name: string, n: number): string {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-${n}${ext}`;
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );
