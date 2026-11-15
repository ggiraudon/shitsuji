import fs from 'node:fs/promises';
import path from 'node:path';
import type { TextFile } from '../../ports/TextFile.js';

/** A text file on the local disk, in UTF-8. */
export class NodeTextFile implements TextFile {
  constructor(readonly path: string) {}

  async read(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(text: string): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, text, 'utf8');
  }
}
