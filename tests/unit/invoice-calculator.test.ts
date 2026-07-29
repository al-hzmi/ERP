import { describe, expect, it } from 'vitest';
import {
  applyHeaderDiscount,
  calculateInvoice,
  type InvoiceLineInput,
} from '@/lib/domain/sales/invoice-calculator';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { unwrap } from '@/lib/domain/shared/result';

function line(overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return {
    productId: 'product-1',
    quantity: Quantity.of('2'),
    unitPrice: Money.of('100', 'SAR'),
    taxRate: '15.00',
    ...overrides,
  };
}

describe('calculateInvoice', () => {
  it('computes line and header totals', () => {
    const invoice = unwrap(calculateInvoice([line()], { currency: 'SAR' }));

    expect(invoice.subtotal.toFixed(2)).toBe('200.00');
    expect(invoice.taxTotal.toFixed(2)).toBe('30.00');
    expect(invoice.total.toFixed(2)).toBe('230.00');
    expect(invoice.lines[0]?.lineTotal.toFixed(2)).toBe('230.00');
  });

  it('applies tax to the amount after discount, not before', () => {
    const invoice = unwrap(
      calculateInvoice([line({ discount: Money.of('50', 'SAR') })], { currency: 'SAR' }),
    );
    // (200 - 50) * 15% = 22.50
    expect(invoice.taxTotal.toFixed(2)).toBe('22.50');
    expect(invoice.total.toFixed(2)).toBe('172.50');
  });

  it('taxes at line level so the header equals the sum of the lines', () => {
    // Three lines whose individual taxes each round, and whose sum differs from
    // taxing the header total in one go. ZATCA rejects the latter.
    const invoice = unwrap(
      calculateInvoice(
        [
          line({ productId: 'a', quantity: Quantity.of('1'), unitPrice: Money.of('33.33', 'SAR') }),
          line({ productId: 'b', quantity: Quantity.of('1'), unitPrice: Money.of('33.33', 'SAR') }),
          line({ productId: 'c', quantity: Quantity.of('1'), unitPrice: Money.of('33.34', 'SAR') }),
        ],
        { currency: 'SAR' },
      ),
    );

    const summedLineTax = invoice.lines.reduce(
      (total, entry) => total.add(entry.taxAmount),
      Money.zero('SAR'),
    );
    expect(invoice.taxTotal.equals(summedLineTax)).toBe(true);

    const summedLineTotals = invoice.lines.reduce(
      (total, entry) => total.add(entry.lineTotal),
      Money.zero('SAR'),
    );
    expect(invoice.total.equals(summedLineTotals)).toBe(true);
  });

  it('supports zero-rated lines alongside standard-rated ones', () => {
    const invoice = unwrap(
      calculateInvoice(
        [line({ productId: 'a' }), line({ productId: 'b', taxRate: '0.00' })],
        { currency: 'SAR' },
      ),
    );
    expect(invoice.taxTotal.toFixed(2)).toBe('30.00');
    expect(invoice.total.toFixed(2)).toBe('430.00');
  });

  it('merges a duplicated product and reports the merge', () => {
    const invoice = unwrap(
      calculateInvoice([line(), line()], { currency: 'SAR' }),
    );

    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]?.quantity.toDisplayString()).toBe('4');
    expect(invoice.mergedProductIds).toEqual(['product-1']);
  });

  it('does not merge the same product across different batches', () => {
    const invoice = unwrap(
      calculateInvoice(
        [line({ batchNumber: 'B1' }), line({ batchNumber: 'B2' })],
        { currency: 'SAR' },
      ),
    );
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.mergedProductIds).toEqual([]);
  });

  it('does not merge serialised items, which are individually unique', () => {
    const invoice = unwrap(
      calculateInvoice(
        [line({ serialNumber: 'SN-1' }), line({ serialNumber: 'SN-1' })],
        { currency: 'SAR' },
      ),
    );
    expect(invoice.lines).toHaveLength(2);
  });

  it('can be told not to merge at all', () => {
    const invoice = unwrap(
      calculateInvoice([line(), line()], { currency: 'SAR', mergeDuplicates: false }),
    );
    expect(invoice.lines).toHaveLength(2);
  });

  // ── Edge cases from the robustness protocol ────────────────────────────────

  it('refuses an invoice with no lines', () => {
    const result = calculateInvoice([], { currency: 'SAR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMPTY_DOCUMENT');
  });

  it('refuses a zero quantity', () => {
    const result = calculateInvoice([line({ quantity: Quantity.zero() })], { currency: 'SAR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('quantity');
  });

  it('refuses a negative quantity', () => {
    const result = calculateInvoice([line({ quantity: Quantity.of('-1') })], { currency: 'SAR' });
    expect(result.ok).toBe(false);
  });

  it('refuses a negative unit price', () => {
    const result = calculateInvoice([line({ unitPrice: Money.of('-5', 'SAR') })], { currency: 'SAR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('unitPrice');
  });

  it('refuses a discount larger than the line', () => {
    const result = calculateInvoice([line({ discount: Money.of('500', 'SAR') })], { currency: 'SAR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('discount');
  });

  it('refuses a tax rate outside 0..100', () => {
    expect(calculateInvoice([line({ taxRate: '150' })], { currency: 'SAR' }).ok).toBe(false);
    expect(calculateInvoice([line({ taxRate: '-1' })], { currency: 'SAR' }).ok).toBe(false);
  });

  it('refuses a line priced in the wrong currency', () => {
    const result = calculateInvoice([line({ unitPrice: Money.of('100', 'USD') })], {
      currency: 'SAR',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('handles very large values without overflow', () => {
    const invoice = unwrap(
      calculateInvoice(
        [line({ quantity: Quantity.of('1'), unitPrice: Money.of('999999999.9999', 'SAR') })],
        { currency: 'SAR' },
      ),
    );
    // 999,999,999.9999 net; VAT of 149,999,999.99985 rounds to 150,000,000.00
    // at the line, which is the figure that actually reaches the ledger.
    expect(invoice.subtotal.toString()).toBe('999999999.9999');
    expect(invoice.taxTotal.toString()).toBe('150000000.0000');
    expect(invoice.total.toString()).toBe('1149999999.9999');
  });

  it('handles fractional quantities', () => {
    const invoice = unwrap(
      calculateInvoice(
        [line({ quantity: Quantity.of('2.5'), unitPrice: Money.of('19.99', 'SAR') })],
        { currency: 'SAR' },
      ),
    );
    // 2.5 * 19.99 = 49.975
    expect(invoice.subtotal.toFixed(4)).toBe('49.9750');
  });
});

describe('applyHeaderDiscount', () => {
  it('distributes proportionally and re-taxes', () => {
    const invoice = unwrap(
      calculateInvoice(
        [
          line({ productId: 'a', quantity: Quantity.of('1'), unitPrice: Money.of('700', 'SAR') }),
          line({ productId: 'b', quantity: Quantity.of('1'), unitPrice: Money.of('300', 'SAR') }),
        ],
        { currency: 'SAR' },
      ),
    );

    const discounted = unwrap(applyHeaderDiscount(invoice, Money.of('100', 'SAR'), 'SAR'));

    expect(discounted.lines[0]?.discount.toFixed(2)).toBe('70.00');
    expect(discounted.lines[1]?.discount.toFixed(2)).toBe('30.00');
    expect(discounted.discountTotal.toFixed(2)).toBe('100.00');
    // (1000 - 100) * 1.15
    expect(discounted.total.toFixed(2)).toBe('1035.00');
  });

  it('never loses a halala, however awkward the split', () => {
    const invoice = unwrap(
      calculateInvoice(
        [
          line({ productId: 'a', quantity: Quantity.of('1'), unitPrice: Money.of('1', 'SAR') }),
          line({ productId: 'b', quantity: Quantity.of('1'), unitPrice: Money.of('1', 'SAR') }),
          line({ productId: 'c', quantity: Quantity.of('1'), unitPrice: Money.of('1', 'SAR') }),
        ],
        { currency: 'SAR' },
      ),
    );

    const discounted = unwrap(applyHeaderDiscount(invoice, Money.of('0.01', 'SAR'), 'SAR'));
    const summed = discounted.lines.reduce(
      (total, entry) => total.add(entry.discount),
      Money.zero('SAR'),
    );
    expect(summed.toFixed(4)).toBe('0.0100');
  });

  it('refuses a header discount larger than the invoice', () => {
    const invoice = unwrap(calculateInvoice([line()], { currency: 'SAR' }));
    const result = applyHeaderDiscount(invoice, Money.of('99999', 'SAR'), 'SAR');
    expect(result.ok).toBe(false);
  });
});
