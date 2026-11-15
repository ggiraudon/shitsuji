import fs from 'node:fs/promises';
import path from 'node:path';
import { newId, type OwnerId } from '../../domain/model/ids.js';
import type { SessionKind } from '../../domain/model/Session.js';
import {
  DEFAULT_SOUL,
  SoulEmpty,
  SoulNoPendingEdit,
  assembleSoul,
  type SoulFragment,
  type SoulRevision,
} from '../../domain/model/Soul.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';
import type { UnitOfWork } from '../../ports/Repositories.js';
import type { SoulStore } from '../../ports/SoulStore.js';

/** What a turn needs to know about the SOUL: the revision and the text for its session kind. */
export interface SoulSource {
  current(sessionKind?: SessionKind): Promise<{ revision: number; body: string }>;
}

export interface SoulServiceDeps {
  store: SoulStore;
  uow: UnitOfWork;
  ownerId: OwnerId;
  clock: Clock;
  log: Logger;
  /** Where SOUL.md is exported; no file when unset. */
  dataDir?: string;
  /** The starting text, before the owner writes one. */
  defaultBody?: string;
}

export interface PendingSoulEdit {
  path: string;
  current: string;
  proposed: string;
}

export interface SoulView {
  revision: SoulRevision;
  /** An unconfirmed edit of SOUL.md, if the file differs from the current revision. */
  pending?: PendingSoulEdit;
}

/**
 * Owns the assembled SOUL (Q6): seeds the first revision, renders the current one for a turn, and
 * turns an edit of the SOUL.md export into a new revision once confirmed. The database holds the
 * real copy; a revision takes effect at the next turn, never in the middle of one.
 */
export class SoulService implements SoulSource {
  readonly filePath?: string;

  constructor(private readonly deps: SoulServiceDeps) {
    if (deps.dataDir) this.filePath = path.join(deps.dataDir, 'SOUL.md');
  }

  /** Seeds the first revision if needed and writes the readable export. Called once at startup. */
  async start(): Promise<SoulRevision> {
    const revision = await this.ensureRevision();
    await this.export();
    return revision;
  }

  /** The revision a turn runs with, assembled for its session kind. */
  async current(sessionKind?: SessionKind): Promise<{ revision: number; body: string }> {
    const revision = await this.ensureRevision();
    return { revision: revision.revision, body: assembleSoul(revision.fragments, sessionKind) };
  }

  async fragments(): Promise<readonly SoulFragment[]> {
    return this.deps.store.fragments(this.deps.ownerId);
  }

  async revisions(): Promise<readonly SoulRevision[]> {
    return this.deps.store.revisions(this.deps.ownerId);
  }

  /** The current revision plus any unconfirmed edit of SOUL.md (for the API and the TUI). */
  async view(): Promise<SoulView> {
    const revision = await this.ensureRevision();
    const pending = await this.pendingEdit();
    return pending ? { revision, pending } : { revision };
  }

  /** Publishes new text as the base fragment: what an owner edit becomes (one fragment, for now). */
  async edit(text: string, source: 'owner' | 'assistant' = 'owner'): Promise<SoulRevision> {
    return this.publish([{ id: newId(), kind: 'base', body: text, position: 0 }], source);
  }

  /** Replaces every fragment and appends a revision, in one transaction. */
  async publish(
    fragments: readonly SoulFragment[],
    source: SoulRevision['source'],
  ): Promise<SoulRevision> {
    const clean = fragments
      .map((f) => ({ ...f, body: f.body.trim() }))
      .filter((f) => f.body.length > 0);
    if (!clean.length) throw new SoulEmpty();
    const body = assembleSoul(clean); // enforces the size cap before anything is written
    return this.deps.uow.run(async (tx) => {
      const latest = await this.deps.store.currentRevision(this.deps.ownerId, tx);
      const revision: SoulRevision = {
        revision: (latest?.revision ?? 0) + 1,
        body,
        fragments: clean,
        source,
        createdAt: this.deps.clock.now(),
      };
      await this.deps.store.replaceFragments(this.deps.ownerId, clean, revision.createdAt, tx);
      await this.deps.store.appendRevision(this.deps.ownerId, revision, tx);
      return revision;
    });
  }

  /** Writes SOUL.md from the current revision. The shared text only; session parts stay in the database. */
  async export(): Promise<void> {
    if (!this.filePath) return;
    const revision = await this.ensureRevision();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, revision.body + '\n', 'utf8');
  }

  /** The edit of SOUL.md waiting to be confirmed, if the file no longer matches the revision. */
  async pendingEdit(): Promise<PendingSoulEdit | undefined> {
    if (!this.filePath) return undefined;
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return undefined; // no file: nothing to confirm
    }
    const revision = await this.ensureRevision();
    const proposed = text.trimEnd();
    if (proposed === revision.body.trimEnd()) return undefined;
    return { path: this.filePath, current: revision.body, proposed };
  }

  /** Confirms the edit of SOUL.md: it becomes the new base, a new revision, and the export is refreshed. */
  async confirmEdit(): Promise<SoulRevision> {
    const pending = await this.pendingEdit();
    if (!pending) throw new SoulNoPendingEdit(this.filePath ?? 'SOUL.md');
    const revision = await this.edit(pending.proposed, 'owner');
    await this.export();
    this.deps.log.info('SOUL updated from the export', { revision: revision.revision });
    return revision;
  }

  private async ensureRevision(): Promise<SoulRevision> {
    const existing = await this.deps.store.currentRevision(this.deps.ownerId);
    if (existing) return existing;
    try {
      return await this.publish(
        [
          {
            id: newId(),
            kind: 'base',
            body: this.deps.defaultBody ?? DEFAULT_SOUL,
            position: 0,
          },
        ],
        'initial',
      );
    } catch (error) {
      // Two processes starting at once: the other one seeded it, so use its revision.
      const raced = await this.deps.store.currentRevision(this.deps.ownerId);
      if (raced) return raced;
      throw error;
    }
  }
}
