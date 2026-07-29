import {
  SCALE,
  absScaled,
  allocateScaled,
  divideScaled,
  formatScaled,
  multiplyScaled,
  parseScaled,
  rescale,
  type RoundingMode,
} from './scaled-decimal';

/** ISO 4217 alphabetic code. Validated on construction, never inferred. */
export type CurrencyCode = string;

/**
 * Thrown when two amounts in different currencies are combined. Adding SAR to USD
 * is not a rounding problem, it is a modelling error, and it fails loudly.
 */
export class CurrencyMismatchError extends Error {
  constructor(
    public readonly left: CurrencyCode,
    public readonly right: CurrencyCode,
  ) {
    super(`Cannot combine amounts in ${left} and ${right} without an explicit conversion.`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * An immutable monetary amount.
 *
 * Every operation returns a new instance; there is no way to mutate an existing
 * one, so an amount can be shared freely across an aggregate without defensive
 * copying. The currency travels with the number, which makes multi-currency
 * mistakes impossible to express rather than merely discouraged.
 */
export class Money {
  /** Scale-4 integer. Private so no caller can bypass the arithmetic rules. */
  private constructor(
    private readonly scaled: bigint,
    public readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  // ── Construction ──────────────────────────────────────────────────────────

  /** Builds an amount from a decimal string such as `"1234.5600"`. */
  static of(value: string | number | bigint, currency: CurrencyCode): Money {
    return new Money(parseScaled(value), normaliseCurrency(currency));
  }

  /** Builds an amount directly from its scale-4 integer representation. */
  static fromScaled(scaled: bigint, currency: CurrencyCode): Money {
    return new Money(scaled, normaliseCurrency(currency));
  }

  /**
   * Builds an amount from minor units — halalas for SAR, cents for USD.
   * `minorUnits` defaults to 2, which covers all currencies this system quotes in.
   */
  static fromMinorUnits(units: bigint | number, currency: CurrencyCode, minorUnits = 2): Money {
    const asBigInt = typeof units === 'number' ? BigInt(Math.trunc(units)) : units;
    const factor = 10n ** BigInt(SCALE - minorUnits);
    return new Money(asBigInt * factor, normaliseCurrency(currency));
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, normaliseCurrency(currency));
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaled + other.scaled, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaled - other.scaled, this.currency);
  }

  /**
   * Scales the amount by a dimensionless factor (a quantity, a rate, a ratio).
   * The factor is taken as a decimal string/number and applied at full precision
   * before a single rounding step.
   */
  multiply(factor: string | number | bigint | Money, mode: RoundingMode = 'HALF_UP'): Money {
    const scaledFactor = factor instanceof Money ? factor.scaled : parseScaled(factor);
    return new Money(multiplyScaled(this.scaled, scaledFactor, mode), this.currency);
  }

  divide(divisor: string | number | bigint, mode: RoundingMode = 'HALF_UP'): Money {
    return new Money(divideScaled(this.scaled, parseScaled(divisor), mode), this.currency);
  }

  negate(): Money {
    return new Money(-this.scaled, this.currency);
  }

  abs(): Money {
    return new Money(absScaled(this.scaled), this.currency);
  }

  /** Rounds to `decimals` places while staying in the scale-4 representation. */
  round(decimals = 2, mode: RoundingMode = 'HALF_UP'): Money {
    return new Money(rescale(this.scaled, decimals, mode), this.currency);
  }

  /**
   * Applies a percentage, e.g. `total.percentage('15.00')` for 15% VAT.
   * Rounds once, at the end — never per intermediate step.
   */
  percentage(rate: string | number, mode: RoundingMode = 'HALF_UP'): Money {
    const rateScaled = parseScaled(rate);
    const hundred = parseScaled('100');
    return new Money(
      divideScaled(multiplyScaled(this.scaled, rateScaled, 'HALF_UP'), hundred, mode),
      this.currency,
    );
  }

  /**
   * Splits this amount across `weights` such that the parts sum back to exactly
   * this amount. Used for distributing a header-level discount over lines, and
   * for apportioning a payment across invoices.
   */
  allocate(weights: readonly (bigint | Money)[]): Money[] {
    const numericWeights = weights.map((weight) =>
      weight instanceof Money ? weight.scaled : weight,
    );
    return allocateScaled(this.scaled, numericWeights).map(
      (share) => new Money(share, this.currency),
    );
  }

  /** Splits into `parts` equal shares, with the remainder spread deterministically. */
  split(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new RangeError(`Cannot split into ${parts} parts`);
    }
    return this.allocate(new Array<bigint>(parts).fill(1n));
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  /** -1, 0 or 1. Throws on a currency mismatch rather than comparing apples to oranges. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.scaled === other.scaled;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  get isZero(): boolean {
    return this.scaled === 0n;
  }

  get isPositive(): boolean {
    return this.scaled > 0n;
  }

  get isNegative(): boolean {
    return this.scaled < 0n;
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  /**
   * Converts to another currency at an explicit rate. There is deliberately no
   * default rate and no ambient rate lookup: a conversion is always a decision
   * someone made, recorded with the rate that was used.
   */
  convertTo(currency: CurrencyCode, rate: string | number, mode: RoundingMode = 'HALF_UP'): Money {
    return new Money(multiplyScaled(this.scaled, parseScaled(rate), mode), normaliseCurrency(currency));
  }

  /** The raw scale-4 integer, for persistence and for the test suite. */
  toScaled(): bigint {
    return this.scaled;
  }

  /** Minor units (halalas for SAR), rounded per `mode`. */
  toMinorUnits(minorUnits = 2, mode: RoundingMode = 'HALF_UP'): bigint {
    const divisor = 10n ** BigInt(SCALE - minorUnits);
    return rescale(this.scaled, minorUnits, mode) / divisor;
  }

  /** Plain decimal string with 4 places — the exact form PostgreSQL stores. */
  toString(): string {
    return formatScaled(this.scaled, SCALE);
  }

  /** Decimal string with the given number of places, for display and for XML. */
  toFixed(decimals = 2): string {
    return formatScaled(this.scaled, decimals);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toString(), currency: this.currency };
  }

  // ── Aggregate helpers ─────────────────────────────────────────────────────

  /** Sums a list, returning zero in `currency` when the list is empty. */
  static sum(amounts: readonly Money[], currency: CurrencyCode): Money {
    return amounts.reduce<Money>((total, amount) => total.add(amount), Money.zero(currency));
  }

  static min(left: Money, right: Money): Money {
    return left.lessThanOrEqual(right) ? left : right;
  }

  static max(left: Money, right: Money): Money {
    return left.greaterThanOrEqual(right) ? left : right;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function normaliseCurrency(currency: CurrencyCode): CurrencyCode {
  const upper = currency.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(upper)) {
    throw new RangeError(`"${currency}" is not a valid ISO 4217 currency code.`);
  }
  return upper;
}
