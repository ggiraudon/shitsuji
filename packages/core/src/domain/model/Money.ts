/**
 * An amount of money as an integer number of micro-units (1/1,000,000 of the currency unit), so sums
 * of many tiny model costs stay exact. Immutable.
 */
export class Money {
  private constructor(
    readonly micros: number,
    readonly currency: string,
  ) {
    if (!Number.isSafeInteger(micros)) throw new RangeError(`Money out of range: ${micros} micros`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`Invalid currency code: ${currency}`);
  }

  static zero(currency = 'USD'): Money {
    return new Money(0, currency);
  }

  /** From a decimal amount, e.g. Money.of(0.27, 'USD'). Rounded to the nearest micro-unit. */
  static of(amount: number, currency = 'USD'): Money {
    return new Money(Math.round(amount * 1_000_000), currency);
  }

  static fromMicros(micros: number, currency = 'USD'): Money {
    return new Money(micros, currency);
  }

  get amount(): number {
    return this.micros / 1_000_000;
  }

  plus(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.micros + other.micros, this.currency);
  }

  /** Multiplies by a factor, e.g. tokens / 1e6 for a per-million price. Rounded to micro-units. */
  times(factor: number): Money {
    return new Money(Math.round(this.micros * factor), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.sameCurrency(other);
    return Math.sign(this.micros - other.micros) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.micros === 0;
  }

  /** "0.0123 USD": up to 6 decimals, trailing zeros trimmed, at least 2. */
  toString(): string {
    const fixed = this.amount.toFixed(6).replace(/0+$/, '');
    const [whole, decimals = ''] = fixed.split('.');
    return `${whole}.${decimals.padEnd(2, '0')} ${this.currency}`;
  }

  toJSON(): { micros: number; currency: string } {
    return { micros: this.micros, currency: this.currency };
  }

  private sameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new RangeError(`Cannot combine ${this.currency} and ${other.currency}`);
    }
  }
}
