import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * The owner key for the API (decision Q3). Created at first start: only its SHA-256 is kept as the
 * reference (`owner-key.sha256`); the key itself is written once to `owner.key` (mode 600) for the TUI
 * on the same machine, and shown in the log at creation. Delete both files to rotate.
 */
export class OwnerKeyFile {
  /** The key's hash, loaded by `ensure`; `verify` compares against it in constant time. */
  private expected?: Buffer;

  constructor(
    /** The data folder that holds `owner.key` and `owner-key.sha256`. */
    private readonly dataDir: string,
  ) {}

  /** Where the readable key is written for the TUI; the hash lives beside it. */
  get keyPath(): string {
    return path.join(this.dataDir, 'owner.key');
  }

  /** Loads the key hash, creating a key first if there is none. Returns the new key when it made one. */
  async ensure(): Promise<{
    /** The key it just generated, so the caller can show it once; undefined when one already existed. */
    created: string | undefined;
  }> {
    const hashPath = path.join(this.dataDir, 'owner-key.sha256');
    try {
      this.expected = Buffer.from((await fs.readFile(hashPath, 'utf8')).trim(), 'hex');
      return { created: undefined };
    } catch {
      const key = `shk_${randomBytes(32).toString('base64url')}`;
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.keyPath, `${key}\n`, { mode: 0o600 });
      await fs.writeFile(hashPath, `${hash(key)}\n`, { mode: 0o600 });
      this.expected = Buffer.from(hash(key), 'hex');
      return { created: key };
    }
  }

  /** Constant-time check of a presented key. */
  verify(presented: string | undefined): boolean {
    if (!presented || !this.expected) return false;
    const actual = Buffer.from(hash(presented), 'hex');
    return actual.length === this.expected.length && timingSafeEqual(actual, this.expected);
  }
}
