import { InvalidTransition } from '../errors.js';
import type { OwnerId, ThreadId } from './ids.js';

/** A thread is `active` while the owner can start sessions in it, and `archived` afterwards. */
export type ThreadStatus = 'active' | 'archived';

/**
 * The one ongoing conversation with an owner, across every channel. Messages from Telegram, the TUI
 * and the webhook all land here, which is why sessions (not threads) are the unit that starts clean.
 * `ThreadRepository.getOrCreateForOwner` creates it on first use, so there is exactly one per owner.
 */
export class Thread {
  constructor(
    /** The thread's id; messages and sessions refer to it. */
    readonly id: ThreadId,
    /** The owner whose conversation this is; one active thread per owner. */
    readonly ownerId: OwnerId,
    /** When it was created, from the injected clock. */
    readonly createdAt: Date,
    /** The current status; changed only through {@link Thread.archive}. */
    private _status: ThreadStatus = 'active',
  ) {}

  /** `active` while sessions may start in the thread, `archived` afterwards. */
  get status(): ThreadStatus {
    return this._status;
  }

  /**
   * Ends the thread. Archiving twice is an error (`InvalidTransition`), not a no-op, so a caller
   * that archives by mistake does not silently hide it.
   */
  archive(): void {
    if (this._status === 'archived') throw new InvalidTransition('Thread', 'archived', 'archived');
    this._status = 'archived';
  }
}
