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
    readonly id: ThreadId,
    readonly ownerId: OwnerId,
    readonly createdAt: Date,
    private _status: ThreadStatus = 'active',
  ) {}

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
