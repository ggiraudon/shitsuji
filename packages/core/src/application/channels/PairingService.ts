import { randomBytes } from 'node:crypto';
import type { OwnerId } from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';

/** A code to show the owner, and when it stops being accepted. */
export interface PairingCode {
  /** The code itself, already in the unambiguous alphabet. */
  code: string;
  /** When `consume` will start refusing it. */
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
  /** The unspent codes: code → the owner it pairs with, and its expiry. */
  private readonly codes = new Map<
    string,
    {
      /** The owner the code pairs. */
      ownerId: OwnerId;
      /** When it stops being accepted. */
      expiresAt: Date;
    }
  >();
  /** How long a new code stays valid. */
  private readonly ttlMs: number;
  /** Makes a new code; injectable so a test can force collisions. */
  private readonly newCode: () => string;

  constructor(
    /** Injected clock: expiry is compared against it. */
    private readonly clock: Clock,
    /** Overrides for the lifetime and the code generator, for tests. */
    options: { ttlMs?: number; code?: () => string } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.newCode = options.code ?? randomCode;
  }

  /** Issues a code for the owner, first dropping the expired ones. */
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

  /** Drops the expired codes, so the map cannot grow with codes nobody used. */
  private prune(now: Date): void {
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt.getTime() <= now.getTime()) this.codes.delete(code);
    }
  }
}

function randomCode(): string {
  return [...randomBytes(8)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}
