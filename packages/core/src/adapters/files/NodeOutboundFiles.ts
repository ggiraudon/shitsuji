import fs from 'node:fs/promises';
import path from 'node:path';
import type { OutboundFiles } from '../../ports/OutboundFiles.js';

/**
 * Stages a sandbox file in a folder on `core`'s disk, inside the handoff folder so a channel there
 * can read it. The name is kept (the owner sees it), with anything a path could not hold replaced.
 */
export class NodeOutboundFiles implements OutboundFiles {
  constructor(
    /** The outbox folder, `<dataDir>/handoff/outbox`; the channel adapters read from it. */
    private readonly dir: string,
  ) {}

  /** Writes the bytes under a sanitized name and returns the absolute path. */
  async stage(name: string, bytes: Uint8Array): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const safe = path.basename(name).replace(/[^\w.\-() ]+/g, '_') || 'file';
    const file = path.join(this.dir, safe);
    await fs.writeFile(file, bytes);
    return file;
  }
}
