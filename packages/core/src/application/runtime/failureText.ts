/**
 * A line for the owner when a turn fails (F04, #101). The turn row keeps the raw reason for
 * debugging; this maps the infrastructure failures that are not the owner's fault to plain words,
 * and keeps every other reason visible as `Error: …`.
 */
export function failureText(reason: string): string {
  if (
    /unsupported Unicode escape sequence|invalid byte sequence for encoding|null byte|\\u0000/i.test(
      reason,
    )
  ) {
    return (
      "I couldn't save that result because it contained text the database cannot store, so the " +
      'turn stopped. If it was a binary file, ask for a text file instead.'
    );
  }
  if (/context length|maximum context|too many tokens/i.test(reason)) {
    return 'That conversation got too long for the model, so the turn stopped. Try a new conversation.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i.test(reason)) {
    return 'The model service could not be reached, so the turn stopped. Try again in a moment.';
  }
  return `Error: ${reason}`;
}
