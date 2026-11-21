import type { Authority } from './Authority.js';

/**
 * Confirms that the quote a judge allowed with really appears in the authority it was shown (F11,
 * S35). A made-up or paraphrased quote fails, and so does one that spans two messages: the owner must
 * have said this, in one place.
 */
export class QuoteVerifier {
  /** `minChars` rejects an empty or trivially short quote that would authorise anything. */
  constructor(
    /** The shortest quote accepted, in characters; three by default. */
    private readonly minChars = 3,
  ) {}

  /** True when the trimmed quote is long enough and appears verbatim in one owner message or instruction. */
  verify(quote: string | undefined, authority: Authority): boolean {
    const candidate = quote?.trim();
    if (!candidate || candidate.length < this.minChars) return false;
    const sources = [...authority.words, ...(authority.instruction ? [authority.instruction] : [])];
    return sources.some((words) => words.includes(candidate));
  }
}
