import {
  SCALE,
  absScaled,
  divideScaled,
  formatScaled,
  multiplyScaled,
  parseScaled,
  type RoundingMode,
} from './scaled-decimal';

/**
 * An immutable stock quantity.
 *
 * Kept separate from `Money` on purpose: a quantity times a unit price is money,
 * but a quantity plus money is meaningless, and the type system should say so.
 * Direction (receipt vs issue) is never encoded in the sign here — it lives in
 * the movement type — so a `Quantity` on a document line is always positive.
 */
export class Quantity {
  private constructor(private readonly scaled: bigint) {
    Object.freeze(this);
  }

  static of(value: string | number | bigint): Quantity {
    return new Quantity(parseScaled(value));
  }

  static fromScaled(scaled: bigint): Quantity {
    return new Quantity(scaled);
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.scaled + other.scaled);
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.scaled - other.scaled);
  }

  multiply(factor: string | number | bigint, mode: RoundingMode = 'HALF_UP'): Quantity {
    return new Quantity(multiplyScaled(this.scaled, parseScaled(factor), mode));
  }

  divide(divisor: string | number | bigint, mode: RoundingMode = 'HALF_UP'): Quantity {
    return new Quantity(divideScaled(this.scaled, parseScaled(divisor), mode));
  }

  negate(): Quantity {
    return new Quantity(-this.scaled);
  }

  abs(): Quantity {
    return new Quantity(absScaled(this.scaled));
  }

  /**
   * Converts between units of measure using the conversion factor held on the
   * UoM record (e.g. a BOX of 12 -> `toBaseUnits('12')` yields 12 PCS).
   */
  toBaseUnits(factor: string | number, mode: RoundingMode = 'HALF_UP'): Quantity {
    return this.multiply(factor, mode);
  }

  compare(other: Quantity): -1 | 0 | 1 {
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Quantity): boolean {
    return this.scaled === other.scaled;
  }

  greaterThan(other: Quantity): boolean {
    return this.scaled > other.scaled;
  }

  greaterThanOrEqual(other: Quantity): boolean {
    return this.scaled >= other.scaled;
  }

  lessThan(other: Quantity): boolean {
    return this.scaled < other.scaled;
  }

  lessThanOrEqual(other: Quantity): boolean {
    return this.scaled <= other.scaled;
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

  toScaled(): bigint {
    return this.scaled;
  }

  toString(): string {
    return formatScaled(this.scaled, SCALE);
  }

  /** Trims trailing zeros for display: `5.0000` reads better as `5`. */
  toDisplayString(maxDecimals = 4): string {
    const fixed = formatScaled(this.scaled, maxDecimals);
    if (!fixed.includes('.')) return fixed;
    return fixed.replace(/\.?0+$/, '');
  }

  toJSON(): string {
    return this.toString();
  }

  static sum(quantities: readonly Quantity[]): Quantity {
    return quantities.reduce<Quantity>((total, item) => total.add(item), Quantity.zero());
  }

  static min(left: Quantity, right: Quantity): Quantity {
    return left.lessThanOrEqual(right) ? left : right;
  }

  static max(left: Quantity, right: Quantity): Quantity {
    return left.greaterThanOrEqual(right) ? left : right;
  }
}
