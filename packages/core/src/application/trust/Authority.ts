import type { Message } from '../../domain/model/Message.js';
import { textOf } from '../../domain/model/Message.js';
import type { StandingRule } from './StandingRule.js';

/**
 * What the trust judge may see (F11, S35): the owner's own words and the standing rules, and nothing
 * the agent, a tool or the outside world wrote. Tool results, assistant text and system notes are not
 * authority and never enter it.
 */
export interface Authority {
  /** The owner's messages, oldest first. */
  words: string[];
  /** The standing rules in force for this turn (F16 will store them). */
  rules: StandingRule[];
  /** A routine's instruction, when the work did not start from an owner message (F16). */
  instruction?: string;
}

/** What the resolver starts from: a transcript, the rules in force, and an optional instruction. */
export interface AuthoritySources {
  /** The session's transcript, oldest first; only owner messages are used. */
  messages: readonly Message[];
  /** The standing rules in force, when a rule store exists (F16). */
  rules?: readonly StandingRule[];
  /** A routine's instruction, when the work did not start from an owner message (F16). */
  instruction?: string;
}

/**
 * How much of the owner's words the judge sees: the recent request chain, not the whole history. The
 * caps are generous enough for a long request and keep the judge's prompt small (F03 cost).
 */
export const AUTHORITY_LIMITS = {
  /** At most this many owner messages, newest first, before the caps stop the walk. */
  messages: 20,
  /** At most this many characters of owner text in total. */
  chars: 8_000,
} as const;

/** Collects the authority for one turn (F11, S35). No I/O: the caller brings the transcript. */
export class AuthorityResolver {
  /** Keeps the newest owner messages within the caps, oldest first, and copies the rules across. */
  resolve(sources: AuthoritySources): Authority {
    const words: string[] = [];
    let used = 0;
    // Walk back from the newest, so a long history never pushes out the request being judged.
    for (const message of [...sources.messages].reverse()) {
      if (words.length >= AUTHORITY_LIMITS.messages || used >= AUTHORITY_LIMITS.chars) break;
      if (message.author !== 'owner' || message.withdrawn) continue;
      const text = textOf(message).trim();
      if (!text) continue;
      const room = AUTHORITY_LIMITS.chars - used;
      // A single huge message keeps its end, where the request usually is.
      const clipped = text.length > room ? text.slice(text.length - room) : text;
      words.push(clipped);
      used += clipped.length;
    }
    words.reverse();
    return {
      words,
      rules: [...(sources.rules ?? [])],
      ...(sources.instruction && { instruction: sources.instruction }),
    };
  }
}
