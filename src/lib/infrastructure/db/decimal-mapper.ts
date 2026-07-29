import { Prisma } from '@prisma/client';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';

/**
 * The only sanctioned crossing between the database's `DECIMAL` and the domain's
 * value objects.
 *
 * Conversion happens through decimal *strings*, never through `number`. A
 * `Decimal.toNumber()` on the way in, or a `parseFloat` on the way out, silently
 * reintroduces binary floating point to a value the whole system was designed to
 * keep exact — so those calls appear nowhere, and this module exists to make
 * sure no one needs them.
 */

/** Prisma `Decimal` -> domain `Money`. */
export function toMoney(value: Prisma.Decimal | null | undefined, currency: string): Money {
  if (value === null || value === undefined) return Money.zero(currency);
  return Money.of(value.toFixed(4), currency);
}

/** Domain `Money` -> Prisma `Decimal`, at the column's exact scale. */
export function fromMoney(value: Money): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/** Prisma `Decimal` -> domain `Quantity`. */
export function toQuantity(value: Prisma.Decimal | null | undefined): Quantity {
  if (value === null || value === undefined) return Quantity.zero();
  return Quantity.of(value.toFixed(4));
}

/** Domain `Quantity` -> Prisma `Decimal`. */
export function fromQuantity(value: Quantity): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/** Exchange rates carry six decimals rather than four. */
export function toRateString(value: Prisma.Decimal | null | undefined): string {
  if (value === null || value === undefined) return '1.000000';
  return value.toFixed(6);
}

export function fromRateString(rate: string): Prisma.Decimal {
  return new Prisma.Decimal(rate);
}

/** A tax rate is a percentage with two decimals, e.g. `'15.00'`. */
export function toTaxRateString(value: Prisma.Decimal | null | undefined): string {
  if (value === null || value === undefined) return '0.00';
  return value.toFixed(2);
}

export function fromTaxRateString(rate: string): Prisma.Decimal {
  return new Prisma.Decimal(rate);
}

/**
 * Serialises a domain object graph for a JSON response.
 *
 * `Money` and `Quantity` become strings, not numbers: a client that parses
 * `1234.5600` into a double and renders it back has already lost the guarantee
 * the rest of this system works to provide.
 */
export function serialiseForJson<T>(value: T): unknown {
  if (value instanceof Money) return value.toString();
  if (value instanceof Quantity) return value.toString();
  if (value instanceof Prisma.Decimal) return value.toFixed(4);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => serialiseForJson(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serialiseForJson(nested);
    }
    return result;
  }
  return value;
}
