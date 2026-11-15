import { InvalidTransition } from '../errors.js';
import type { OwnerId, ThreadId } from './ids.js';

export type ThreadStatus = 'active' | 'archived';

/** The one ongoing conversation with an owner, across every channel. */
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

  archive(): void {
    if (this._status === 'archived') throw new InvalidTransition('Thread', 'archived', 'archived');
    this._status = 'archived';
  }
}
