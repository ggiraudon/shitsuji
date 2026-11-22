import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Secret } from '../../../domain/Secret.js';

/**
 * The token core and sandboxd share (F08, S48). Core generates it on first start; Compose points
 * this at the `sandbox-secret` volume, whose root is root:1002 0770, and mounts it read-only into
 * the sandbox at `/run/sandbox-seed`. The directory — not the file mode — is what keeps it out of a
 * command's reach: core (uid 1000) is in group 1002 and writes it, commands (uid 1000, gid 1000) are
 * not and cannot traverse the directory. It never goes into an environment, a log or a command.
 *
 * The write stays in place (no rename): a sandbox container may already have the file bind-mounted,
 * and a rename would leave it holding the old, empty inode.
 */
export class SandboxTokenFile {
  constructor(
    /** Where the token lives; its directory's mode is what keeps commands out, not the file's. */
    readonly file: string,
  ) {}

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

  /** The token already in the file, or undefined when the file is absent or empty. */
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
