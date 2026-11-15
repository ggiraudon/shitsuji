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
  body: string;
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
