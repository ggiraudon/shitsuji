import type { ContentPart } from '../../domain/model/Message.js';

/**
 * What goes between two text parts of one message. Without it the model cannot see where one ends:
 * a context tail runs straight into the owner's last word, and a real notification went out with
 * "typed yesCurrent local date…" (#66).
 */
export const TEXT_PART_SEPARATOR = '\n\n';

/** One message's text, its text parts in order and separated, other parts left out. */
export function joinTextParts(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(TEXT_PART_SEPARATOR);
}
