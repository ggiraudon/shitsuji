import { ShitsujiError } from '../errors.js';
import type { SessionKind } from './Session.js';

/**
 * The standing instructions are small on purpose: they start every prompt (F04, Q6). The cap is on
 * the assembled text in bytes, so a SOUL that grows past it fails at publish time, not in a turn.
 */
export const SOUL_MAX_BYTES = 24 * 1024;

/**
 * A base you write, traits you confirmed, and optional parts for one session kind. `base` and `trait`
 * fragments are shared by every session; a `session` fragment is only assembled for its
 * {@link SoulFragment.sessionKind}.
 */
export type SoulFragmentKind = 'base' | 'trait' | 'session';

/** Who made the revision: the first one, the owner, or (from F11) a confirmed proposal. */
export type SoulSource = 'initial' | 'owner' | 'assistant';

/**
 * One piece of the SOUL, as the owner edits it. Fragments are stored as a set and replaced together
 * (`SoulStore.replaceFragments`); a revision records the assembled text they produced.
 */
export interface SoulFragment {
  /** Stable id, used to order fragments with the same position and to keep one across edits. */
  id: string;
  /** Whether it is shared (`base`, `trait`) or limited to one session kind. */
  kind: SoulFragmentKind;
  /** For kind `session`: only that session kind sees this fragment. */
  sessionKind?: SessionKind;
  /** The text as the owner wrote it; trimmed and joined when assembled. */
  body: string;
  /** Ascending within the assembled SOUL. */
  position: number;
}

/**
 * One published state of the SOUL. A turn fixes the revision it started with, so a change confirmed
 * mid-turn waits for the next turn, and history can say what shaped an answer.
 */
export interface SoulRevision {
  /** The revision number, starting at 1 and increasing by one per publish. */
  revision: number;
  /** The assembled shared text (base and traits), for reading and diffing. */
  body: string;
  /** The fragments it was assembled from, so a session-kind part is re-assembled per turn. */
  fragments: readonly SoulFragment[];
  /** Who published it: the first run, the owner, or a confirmed assistant proposal. */
  source: SoulSource;
  /** When it was published, from the injected clock. */
  createdAt: Date;
}

/**
 * The assembled SOUL is over {@link SOUL_MAX_BYTES}, so every prompt would start with too much text.
 * Thrown by {@link assembleSoul} before anything is written.
 */
export class SoulTooLarge extends ShitsujiError {
  override readonly name = 'SoulTooLarge';
  constructor(bytes: number) {
    super(
      'soul_too_large',
      `The assembled SOUL is ${bytes} bytes; the cap is ${SOUL_MAX_BYTES} so the header stays small`,
      { bytes, cap: SOUL_MAX_BYTES },
    );
  }
}

/** The SOUL cannot be empty: the header states who Shitsuji is. Thrown by `SoulService.publish`. */
export class SoulEmpty extends ShitsujiError {
  override readonly name = 'SoulEmpty';
  constructor() {
    super('soul_empty', 'The SOUL would be empty; keep at least one fragment with text');
  }
}

/** An edit was confirmed when SOUL.md had not been changed. Thrown by `SoulService.confirmEdit`. */
export class SoulNoPendingEdit extends ShitsujiError {
  override readonly name = 'SoulNoPendingEdit';
  constructor(file: string) {
    super('soul_no_pending_edit', `${file} is unchanged; there is no edit to confirm`, { file });
  }
}

/**
 * SOUL.md changed again after it was reviewed: confirming would apply text nobody has seen. Thrown by
 * `SoulService.confirmEdit` when the reviewed hash no longer matches the file.
 */
export class SoulEditChanged extends ShitsujiError {
  override readonly name = 'SoulEditChanged';
  constructor(file: string) {
    super(
      'soul_edit_changed',
      `${file} changed after it was reviewed; review it again before confirming`,
      { file },
    );
  }
}

/**
 * Assembles the SOUL from its fragments: base and traits always, session fragments only for their own
 * session kind. The database holds the fragments; a revision is the assembled text (Q6).
 *
 * Fragments are trimmed, empty ones dropped, sorted by `position` (ties by id) and joined with a blank
 * line, so the same set always produces the same text and the provider's prompt cache keeps matching.
 * Throws {@link SoulTooLarge} when the result is over {@link SOUL_MAX_BYTES}.
 */
export function assembleSoul(
  fragments: readonly SoulFragment[],
  sessionKind?: SessionKind,
): string {
  const body = [...fragments]
    .filter((f) => f.kind !== 'session' || (sessionKind && f.sessionKind === sessionKind))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((f) => f.body.trim())
    .filter(Boolean)
    .join('\n\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > SOUL_MAX_BYTES) throw new SoulTooLarge(bytes);
  return body;
}

/**
 * The starting SOUL before the owner writes one. Shitsuji keeps this to what it can be sure of: how to
 * behave, not who the owner is. `SoulService` publishes it as the first revision.
 */
export const DEFAULT_SOUL = `You are Shitsuji, the owner's butler: attentive, precise and brief.

How you behave:
- Do what was asked, then say what you did in one or two sentences.
- Ask before guessing when an action cannot be undone.
- Say plainly when you do not know or cannot do something.`;
