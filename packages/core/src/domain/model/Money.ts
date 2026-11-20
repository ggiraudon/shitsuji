/**
 * An amount of money as an integer number of micro-units (1/1,000,000 of the currency unit), so sums
 * of many tiny model costs stay exact. Immutable.
 *
 * Every operation that could lose precision throws a `RangeError` rather than rounding silently: a
 * constructor with an out-of-range `micros` or a currency that is not three uppercase letters, and
 * `plus`/`compare` on two different currencies. Prices come from the model catalogue, usage from the
 * ledger, and both end up in `BudgetStore` and the usage report.
 */
export class Money {
  private constructor(
    /** The amount in micro-units; always a safe integer. */
    readonly micros: number,
    /** ISO 4217 code (three uppercase letters), e.g. `USD`. */
    readonly currency: string,
  ) {
    if (!Number.isSafeInteger(micros)) throw new RangeError(`Money out of range: ${micros} micros`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`Invalid currency code: ${currency}`);
  }

  /** Nothing spent. */
  static zero(currency = 'USD'): Money {
    return new Money(0, currency);
  }

  /** From a decimal amount, e.g. Money.of(0.27, 'USD'). Rounded to the nearest micro-unit. */
  static of(amount: number, currency = 'USD'): Money {
    return new Money(Math.round(amount * 1_000_000), currency);
  }

  /** From a value already in micro-units, e.g. one read from the database. */
  static fromMicros(micros: number, currency = 'USD'): Money {
    return new Money(micros, currency);
  }

  /** The amount as a decimal number, for display and config; do arithmetic on `micros` instead. */
  get amount(): number {
    return this.micros / 1_000_000;
  }

  /** Sum of two amounts in the same currency; throws a `RangeError` when they differ. */
  plus(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.micros + other.micros, this.currency);
  }

  /** Multiplies by a factor, e.g. tokens / 1e6 for a per-million price. Rounded to micro-units. */
  times(factor: number): Money {
    return new Money(Math.round(this.micros * factor), this.currency);
  }

  /** Ordering for limits; throws a `RangeError` when the currencies differ. */
  compare(other: Money): -1 | 0 | 1 {
    this.sameCurrency(other);
    return Math.sign(this.micros - other.micros) as -1 | 0 | 1;
  }

  /** True when the amount is exactly zero. */
  isZero(): boolean {
    return this.micros === 0;
  }

  /** "0.0123 USD": up to 6 decimals, trailing zeros trimmed, at least 2. */
  toString(): string {
    const fixed = this.amount.toFixed(6).replace(/0+$/, '');
    const [whole, decimals = ''] = fixed.split('.');
    return `${whole}.${decimals.padEnd(2, '0')} ${this.currency}`;
  }

  /** Micro-units and currency, so a stored or API value keeps its exact amount. */
  toJSON(): { micros: number; currency: string } {
    return { micros: this.micros, currency: this.currency };
  }

  /** Rejects arithmetic across currencies instead of inventing an exchange rate. */
  private sameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new RangeError(`Cannot combine ${this.currency} and ${other.currency}`);
    }
  }
}
