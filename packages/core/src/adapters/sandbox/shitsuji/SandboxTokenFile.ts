import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Secret } from '../../../domain/Secret.js';

/**
 * The token core and sandboxd share (F08, S48). Core generates it on first start into its data
 * folder; Compose mounts that one file read-only into the sandbox at `/run/sandbox/token`, where
 * only the root entrypoint and the daemon's uid (1001) can reach it. It never goes into an
 * environment, a log or a command's reach.
 *
 * The write stays in place (no rename): a sandbox container may already have the file bind-mounted,
 * and a rename would leave it holding the old, empty inode.
 */
export class SandboxTokenFile {
  constructor(readonly file: string) {}

  /** The token, read from the file or made (32 random bytes as hex) when the file is empty. */
  readOrCreate(): Secret {
    const existing = this.read();
    if (existing) return new Secret(existing);

    const token = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, token, { mode: 0o644 });
    // An existing file keeps its old mode; the daemon (uid 1001) reads it while the directory
    // keeps commands (uid 1000, the same number as core but another container) out.
    fs.chmodSync(this.file, 0o644);
    return new Secret(token);
  }

  private read(): string | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const token = raw.trim();
    return token.length > 0 ? token : undefined;
  }
}
