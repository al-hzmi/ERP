import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';

describe('Money construction', () => {
  it('normalises the currency code', () => {
    expect(Money.of('10', 'sar').currency).toBe('SAR');
    expect(Money.of('10', ' usd ').currency).toBe('USD');
  });

  it('rejects anything that is not an ISO 4217 code', () => {
    expect(() => Money.of('10', 'RIYAL')).toThrow(RangeError);
    expect(() => Money.of('10', 'S')).toThrow(RangeError);
  });

  it('builds from minor units', () => {
    expect(Money.fromMinorUnits(12_345n, 'SAR').toFixed(2)).toBe('123.45');
    expect(Money.fromMinorUnits(1n, 'SAR').toFixed(2)).toBe('0.01');
  });

  it('is immutable', () => {
    const amount = Money.of('100', 'SAR');
    const doubled = amount.multiply('2');
    expect(amount.toFixed(2)).toBe('100.00');
    expect(doubled.toFixed(2)).toBe('200.00');
    expect(Object.isFrozen(amount)).toBe(true);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.of('0.1', 'SAR');
    const b = Money.of('0.2', 'SAR');
    expect(a.add(b).toFixed(2)).toBe('0.30');
    expect(b.subtract(a).toFixed(4)).toBe('0.1000');
  });

  it('refuses to combine different currencies', () => {
    const sar = Money.of('100', 'SAR');
    const usd = Money.of('100', 'USD');
    expect(() => sar.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => sar.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => sar.compare(usd)).toThrow(CurrencyMismatchError);
  });

  it('computes VAT at 15% correctly', () => {
    expect(Money.of('100', 'SAR').percentage('15').toFixed(2)).toBe('15.00');
    expect(Money.of('333.33', 'SAR').percentage('15').toFixed(2)).toBe('50.00');
    expect(Money.of('0.03', 'SAR').percentage('15').toFixed(4)).toBe('0.0045');
  });

  it('handles the largest supported value without overflow', () => {
    const large = Money.of('999999999999.9999', 'SAR');
    expect(large.toString()).toBe('999999999999.9999');
    expect(large.add(Money.of('0.0001', 'SAR')).toString()).toBe('1000000000000.0000');
  });

  it('normalises negatives through abs and negate', () => {
    const negative = Money.of('-50', 'SAR');
    expect(negative.isNegative).toBe(true);
    expect(negative.abs().toFixed(2)).toBe('50.00');
    expect(negative.negate().toFixed(2)).toBe('50.00');
  });
});

describe('Money allocation', () => {
  it('splits so the parts sum back to the whole', () => {
    const parts = Money.of('100', 'SAR').split(3);
    const total = Money.sum(parts, 'SAR');
    expect(total.toFixed(4)).toBe('100.0000');
  });

  it('allocates a discount proportionally without losing a halala', () => {
    const discount = Money.of('99.99', 'SAR');
    const shares = discount.allocate([
      Money.of('1000', 'SAR'),
      Money.of('333.33', 'SAR'),
      Money.of('0.01', 'SAR'),
    ]);
    expect(Money.sum(shares, 'SAR').toFixed(4)).toBe(discount.toFixed(4));
  });
});

describe('Money conversion', () => {
  it('applies an explicit rate', () => {
    const usd = Money.of('100', 'USD');
    const sar = usd.convertTo('SAR', '3.75');
    expect(sar.currency).toBe('SAR');
    expect(sar.toFixed(2)).toBe('375.00');
  });

  it('accepts the full six decimals an exchange rate column can hold', () => {
    // Exchange rates live in DECIMAL(19,6). Parsing them at scale 4 would reject
    // this outright, which is exactly the bug this test was written to catch.
    const converted = Money.of('33.33', 'USD').convertTo('SAR', '3.751234').round(2);
    // 33.33 x 3.751234 = 125.02862922 -> 125.03
    expect(converted.toFixed(2)).toBe('125.03');
  });

  it('handles a rate far below one without losing precision', () => {
    // JPY/SAR. At scale 4 this rate would round to 0.0254 and move a large
    // invoice by thousands.
    const converted = Money.of('1000000', 'JPY').convertTo('SAR', '0.025431').round(2);
    expect(converted.toFixed(2)).toBe('25431.00');
  });

  it('rejects a rate carrying more than six decimals', () => {
    expect(() => Money.of('100', 'USD').convertTo('SAR', '3.7512345')).toThrow();
  });
});

describe('Quantity', () => {
  it('trims trailing zeros for display', () => {
    expect(Quantity.of('5').toDisplayString()).toBe('5');
    expect(Quantity.of('5.5000').toDisplayString()).toBe('5.5');
    expect(Quantity.of('0.2500').toDisplayString()).toBe('0.25');
  });

  it('converts between units of measure', () => {
    // 3 boxes of 12 = 36 pieces
    expect(Quantity.of('3').toBaseUnits('12').toDisplayString()).toBe('36');
  });

  it('compares without a currency', () => {
    expect(Quantity.of('10').greaterThan(Quantity.of('9.9999'))).toBe(true);
    expect(Quantity.min(Quantity.of('3'), Quantity.of('7')).toDisplayString()).toBe('3');
  });
});
