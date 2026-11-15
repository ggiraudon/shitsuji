import { ShitsujiError } from '../errors.js';
import type { SessionKind } from './Session.js';

/** The standing instructions are small on purpose: they start every prompt (F04, Q6). */
export const SOUL_MAX_BYTES = 24 * 1024;

/** A base you write, traits you confirmed, and optional parts for one session kind. */
export type SoulFragmentKind = 'base' | 'trait' | 'session';

/** Who made the revision: the first one, the owner, or (from F11) a confirmed proposal. */
export type SoulSource = 'initial' | 'owner' | 'assistant';

export interface SoulFragment {
  id: string;
  kind: SoulFragmentKind;
  /** For kind `session`: only that session kind sees this fragment. */
  sessionKind?: SessionKind;
  body: string;
  /** Ascending within the assembled SOUL. */
  position: number;
}

export interface SoulRevision {
  revision: number;
  /** The assembled shared text (base and traits), for reading and diffing. */
  body: string;
  /** The fragments it was assembled from, so a session-kind part is re-assembled per turn. */
  fragments: readonly SoulFragment[];
  source: SoulSource;
  createdAt: Date;
}

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

/** The SOUL cannot be empty: the header states who Shitsuji is. */
export class SoulEmpty extends ShitsujiError {
  override readonly name = 'SoulEmpty';
  constructor() {
    super('soul_empty', 'The SOUL would be empty; keep at least one fragment with text');
  }
}

/** An edit was confirmed when SOUL.md had not been changed. */
export class SoulNoPendingEdit extends ShitsujiError {
  override readonly name = 'SoulNoPendingEdit';
  constructor(file: string) {
    super('soul_no_pending_edit', `${file} is unchanged; there is no edit to confirm`, { file });
  }
}

/**
 * Assembles the SOUL from its fragments: base and traits always, session fragments only for their own
 * session kind. The database holds the fragments; a revision is the assembled text (Q6).
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

/** The starting SOUL before the owner writes one. Shitsuji keeps this to what it can be sure of. */
export const DEFAULT_SOUL = `You are Shitsuji, the owner's butler: attentive, precise and brief.

How you behave:
- Do what was asked, then say what you did in one or two sentences.
- Ask before guessing when an action cannot be undone.
- Say plainly when you do not know or cannot do something.`;
