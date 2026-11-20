const REDACTED = '[secret]';
const value = new WeakMap<Secret, string>();

/**
 * Wraps a credential so it cannot leak by accident: string conversion, JSON, and Node's inspect all
 * print "[secret]". Only `reveal()` returns the value, so every real use is easy to find with grep.
 *
 * The raw value lives in a WeakMap rather than on the instance, so it is not enumerable: spreading the
 * object, `Object.keys` or a structured clone cannot pick it up. The wrapper is safe to log and to pass
 * around; the value it guards is not.
 */
export class Secret {
  /** Wraps the raw value. Keep the wrapper; it is what travels through config and adapters. */
  constructor(raw: string) {
    value.set(this, raw);
  }

  /**
   * The raw value, for the one place that must hand it to an external system. Treat each call as a
   * reviewed place: never log the result, never put it in an error message or details, never send it to
   * a model or into a container.
   */
  reveal(): string {
    return value.get(this)!;
  }

  /** Template literals and `String(secret)` print the redaction, never the value. */
  toString(): string {
    return REDACTED;
  }

  /** `JSON.stringify(secret)` prints the redaction; an API response cannot serialise a key by accident. */
  toJSON(): string {
    return REDACTED;
  }

  /** `console.log` and the debugger show the redaction. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }

  /** Arithmetic and comparison coerce to the redaction, so a secret cannot become a number or a key. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}
