const REDACTED = '[secret]';
const value = new WeakMap<Secret, string>();

/**
 * Wraps a credential so it cannot leak by accident: string conversion, JSON, and Node's inspect all
 * print "[secret]". Only `reveal()` returns the value, so every real use is easy to find with grep.
 */
export class Secret {
  constructor(raw: string) {
    value.set(this, raw);
  }

  reveal(): string {
    return value.get(this)!;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}
