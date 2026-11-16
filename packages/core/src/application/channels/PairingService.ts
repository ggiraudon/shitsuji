import { randomBytes } from 'node:crypto';
import type { OwnerId } from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';

export interface PairingCode {
  code: string;
  expiresAt: Date;
}

/** No 0/O or 1/I, so a code read aloud or typed on a phone is unambiguous. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Short-lived, single-use codes that pair a chat with the owner (F06, S31). In memory on purpose:
 * a restart invalidates unfilled codes, which is safer than a code surviving unnoticed, and /pair can
 * always issue another. The owner id travels with the code, so a code cannot pair someone else's chat.
 */
export class PairingService {
  private readonly codes = new Map<string, { ownerId: OwnerId; expiresAt: Date }>();
  private readonly ttlMs: number;
  private readonly newCode: () => string;

  constructor(
    private readonly clock: Clock,
    options: { ttlMs?: number; code?: () => string } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.newCode = options.code ?? randomCode;
  }

  issue(ownerId: OwnerId): PairingCode {
    const now = this.clock.now();
    this.prune(now);
    let code = this.newCode().toUpperCase();
    while (this.codes.has(code)) code = this.newCode().toUpperCase();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    this.codes.set(code, { ownerId, expiresAt });
    return { code, expiresAt };
  }

  /** Single use: a valid code is removed as it is consumed, and an expired one is refused. */
  consume(input: string, now: Date = this.clock.now()): OwnerId | undefined {
    const code = input.trim().toUpperCase();
    const found = this.codes.get(code);
    if (!found) return undefined;
    this.codes.delete(code);
    if (found.expiresAt.getTime() <= now.getTime()) return undefined;
    return found.ownerId;
  }

  private prune(now: Date): void {
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt.getTime() <= now.getTime()) this.codes.delete(code);
    }
  }
}

function randomCode(): string {
  return [...randomBytes(8)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}
