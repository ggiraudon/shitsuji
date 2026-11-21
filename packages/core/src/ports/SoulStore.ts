import type { OwnerId } from '../domain/model/ids.js';
import type { SoulFragment, SoulRevision } from '../domain/model/Soul.js';
import type { Transaction } from './Repositories.js';

/**
 * The SOUL's storage: ordered fragments and numbered revisions. The fragments are the editable copy;
 * a revision is the assembled text a turn ran with, so history and undo need no re-assembly (F04, Q6).
 */
/** The SOUL's storage. `replaceFragments` and `appendRevision` belong in one transaction. */
export interface SoulStore {
  /** Every fragment, in position order. */
  fragments(ownerId: OwnerId, tx?: Transaction): Promise<SoulFragment[]>;
  /** Replaces the whole set in one go: the fragments are edited together, never one by one. */
  replaceFragments(
    ownerId: OwnerId,
    fragments: readonly SoulFragment[],
    at: Date,
    tx?: Transaction,
  ): Promise<void>;
  /** The newest revision, or undefined before the first one is published. */
  currentRevision(ownerId: OwnerId, tx?: Transaction): Promise<SoulRevision | undefined>;
  /** Every revision, oldest first (for diff and undo). */
  revisions(ownerId: OwnerId, tx?: Transaction): Promise<SoulRevision[]>;
  /** Appends the next revision after `replaceFragments`; both belong in one transaction. */
  appendRevision(ownerId: OwnerId, revision: SoulRevision, tx?: Transaction): Promise<void>;
}
