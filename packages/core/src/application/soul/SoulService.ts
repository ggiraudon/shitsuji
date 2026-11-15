import { createHash } from 'node:crypto';
import { newId, type OwnerId } from '../../domain/model/ids.js';
import type { SessionKind } from '../../domain/model/Session.js';
import {
  DEFAULT_SOUL,
  SoulEditChanged,
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
import type { TextFile } from '../../ports/TextFile.js';

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
  /** The SOUL.md export; no file when unset. */
  file?: TextFile;
  /** The starting text, before the owner writes one. */
  defaultBody?: string;
}

export interface PendingSoulEdit {
  path: string;
  current: string;
  proposed: string;
  /** SHA-256 of `proposed`: confirming with it applies exactly the text that was reviewed. */
  hash: string;
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
  constructor(private readonly deps: SoulServiceDeps) {}

  get filePath(): string | undefined {
    return this.deps.file?.path;
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

  /**
   * Publishes new shared text. The export shows the base and traits assembled into one text, so an
   * edit of it replaces both with one base fragment. Session-kind fragments are not in the export and
   * are kept as they are.
   */
  async edit(text: string, source: 'owner' | 'assistant' = 'owner'): Promise<SoulRevision> {
    const current = await this.ensureRevision();
    const kept = current.fragments.filter((f) => f.kind === 'session');
    return this.publish([{ id: newId(), kind: 'base', body: text, position: 0 }, ...kept], source);
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
    // The size cap is checked before anything is written, for every session kind's assembly: a turn
    // must never be the first to find its SOUL too large.
    const body = assembleSoul(clean);
    for (const kind of new Set(clean.flatMap((f) => (f.sessionKind ? [f.sessionKind] : [])))) {
      assembleSoul(clean, kind);
    }
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
    if (!this.deps.file) return;
    const revision = await this.ensureRevision();
    await this.deps.file.write(`${revision.body}\n`);
  }

  /** The edit of SOUL.md waiting to be confirmed, if the file no longer matches the revision. */
  async pendingEdit(): Promise<PendingSoulEdit | undefined> {
    const file = this.deps.file;
    if (!file) return undefined;
    const text = await file.read();
    if (text === undefined) return undefined; // no file: nothing to confirm
    const revision = await this.ensureRevision();
    // An editor saving CRLF line endings is not an edit.
    const proposed = text.replace(/\r\n/g, '\n').trimEnd();
    if (proposed === revision.body.trimEnd()) return undefined;
    return { path: file.path, current: revision.body, proposed, hash: hashOf(proposed) };
  }

  /**
   * Confirms the edit of SOUL.md: it becomes the new base, a new revision, and the export is refreshed.
   * `reviewed` is the hash of the text the owner saw; if the file changed since, nothing is applied.
   */
  async confirmEdit(reviewed?: string): Promise<SoulRevision> {
    const pending = await this.pendingEdit();
    if (!pending) throw new SoulNoPendingEdit(this.filePath ?? 'SOUL.md');
    if (reviewed !== undefined && reviewed !== pending.hash) {
      throw new SoulEditChanged(pending.path);
    }
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

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
