import { DomainErrors, type DomainError } from '../shared/errors';
import { Money } from '../shared/money';
import { Quantity } from '../shared/quantity';
import { err, ok, type Result } from '../shared/result';

/**
 * Invoice arithmetic.
 *
 * Tax is computed per line and then summed — never on the header total. Summing
 * first and taxing once produces a figure that differs from the sum of the line
 * taxes by a halala or two, which is the single most common reason a ZATCA
 * submission is rejected: the XML's line totals must add up to its header.
 */

export interface InvoiceLineInput {
  readonly productId: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  /** Absolute discount on the line, in the invoice currency. */
  readonly discount?: Money;
  /** Percentage, e.g. `'15.00'`. Applied to (gross - discount). */
  readonly taxRate: string;
  readonly descriptionAr?: string;
  readonly batchNumber?: string;
  readonly serialNumber?: string;
  readonly expiryDate?: string;
}

export interface CalculatedInvoiceLine {
  readonly lineNumber: number;
  readonly productId: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly discount: Money;
  readonly taxRate: string;
  /** quantity x unitPrice */
  readonly grossAmount: Money;
  /** grossAmount - discount */
  readonly netAmount: Money;
  readonly taxAmount: Money;
  /** netAmount + taxAmount */
  readonly lineTotal: Money;
  readonly descriptionAr: string | null;
  readonly batchNumber: string | null;
  readonly serialNumber: string | null;
  readonly expiryDate: string | null;
}

export interface CalculatedInvoice {
  readonly lines: readonly CalculatedInvoiceLine[];
  /** Sum of gross line amounts, before discount and tax. */
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  /** subtotal - discountTotal + taxTotal */
  readonly total: Money;
  /**
   * Lines that were merged because the same product appeared more than once.
   * Surfaced to the user as a notice — silently changing their input is rude,
   * and leaving two lines for one product breaks stock reservation.
   */
  readonly mergedProductIds: readonly string[];
}

export interface CalculateInvoiceOptions {
  readonly currency: string;
  /**
   * When true (the default), repeating a product adds to the existing line
   * rather than creating a second one.
   */
  readonly mergeDuplicates?: boolean;
}

/**
 * Turns raw line input into a fully costed invoice, or explains why it cannot.
 *
 * Every failure is a business rule the user can act on: an empty invoice, a
 * zero quantity, a discount larger than the line, a tax rate outside 0–100.
 */
export function calculateInvoice(
  inputs: readonly InvoiceLineInput[],
  options: CalculateInvoiceOptions,
): Result<CalculatedInvoice, DomainError> {
  const currency = options.currency;
  const mergeDuplicates = options.mergeDuplicates ?? true;

  if (inputs.length === 0) {
    return err(DomainErrors.emptyDocument('الفاتورة', 'An invoice'));
  }

  const merged = mergeDuplicates ? mergeDuplicateLines(inputs) : { lines: inputs, mergedProductIds: [] };

  const lines: CalculatedInvoiceLine[] = [];

  for (const [index, input] of merged.lines.entries()) {
    const lineNumber = index + 1;

    if (!input.quantity.isPositive) {
      return err(
        DomainErrors.validation(
          `البند رقم ${lineNumber}: الكمية يجب أن تكون أكبر من صفر.`,
          `Line ${lineNumber}: the quantity must be greater than zero.`,
          'quantity',
        ),
      );
    }

    if (input.unitPrice.isNegative) {
      return err(
        DomainErrors.validation(
          `البند رقم ${lineNumber}: سعر الوحدة لا يمكن أن يكون سالباً.`,
          `Line ${lineNumber}: the unit price cannot be negative.`,
          'unitPrice',
        ),
      );
    }

    if (input.unitPrice.currency !== currency) {
      return err(DomainErrors.currencyMismatch(currency, input.unitPrice.currency));
    }

    const taxRateCheck = parseTaxRate(input.taxRate, lineNumber);
    if (!taxRateCheck.ok) return taxRateCheck;

    const grossAmount = input.unitPrice.multiply(input.quantity.toString());
    const discount = input.discount ?? Money.zero(currency);

    if (discount.isNegative) {
      return err(
        DomainErrors.validation(
          `البند رقم ${lineNumber}: الخصم لا يمكن أن يكون سالباً.`,
          `Line ${lineNumber}: the discount cannot be negative.`,
          'discount',
        ),
      );
    }

    if (discount.greaterThan(grossAmount)) {
      return err(
        DomainErrors.validation(
          `البند رقم ${lineNumber}: الخصم (${discount.toFixed(2)}) يتجاوز قيمة البند (${grossAmount.toFixed(2)}).`,
          `Line ${lineNumber}: the discount (${discount.toFixed(2)}) exceeds the line amount (${grossAmount.toFixed(2)}).`,
          'discount',
        ),
      );
    }

    const netAmount = grossAmount.subtract(discount);
    // Single rounding step, on the line, at 2 decimals — the currency's scale.
    const taxAmount = netAmount.percentage(input.taxRate).round(2);
    const lineTotal = netAmount.add(taxAmount);

    lines.push({
      lineNumber,
      productId: input.productId,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discount,
      taxRate: input.taxRate,
      grossAmount,
      netAmount,
      taxAmount,
      lineTotal,
      descriptionAr: input.descriptionAr ?? null,
      batchNumber: input.batchNumber ?? null,
      serialNumber: input.serialNumber ?? null,
      expiryDate: input.expiryDate ?? null,
    });
  }

  const subtotal = Money.sum(lines.map((line) => line.grossAmount), currency);
  const discountTotal = Money.sum(lines.map((line) => line.discount), currency);
  const taxTotal = Money.sum(lines.map((line) => line.taxAmount), currency);
  const total = subtotal.subtract(discountTotal).add(taxTotal);

  return ok({
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total,
    mergedProductIds: merged.mergedProductIds,
  });
}

/**
 * Combines repeated products into a single line.
 *
 * Quantities and discounts add; the unit price of the first occurrence wins,
 * because a user who scans the same item twice means "two of them at the price
 * I already agreed", not "renegotiate". Lines that differ by batch or serial are
 * intentionally NOT merged — they are physically different goods.
 */
function mergeDuplicateLines(inputs: readonly InvoiceLineInput[]): {
  lines: InvoiceLineInput[];
  mergedProductIds: string[];
} {
  const byKey = new Map<string, InvoiceLineInput>();
  const order: string[] = [];
  const mergedProductIds = new Set<string>();

  for (const input of inputs) {
    const key = [
      input.productId,
      input.batchNumber ?? '',
      input.serialNumber ?? '',
      input.taxRate,
    ].join('|');

    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, input);
      order.push(key);
      continue;
    }

    // A serialised item is unique by definition — two of the same serial is an
    // input error, not a quantity of two. Leave it alone and let validation speak.
    if (input.serialNumber !== undefined && input.serialNumber !== '') {
      const uniqueKey = `${key}#${order.length}`;
      byKey.set(uniqueKey, input);
      order.push(uniqueKey);
      continue;
    }

    mergedProductIds.add(input.productId);
    byKey.set(key, {
      ...existing,
      quantity: existing.quantity.add(input.quantity),
      discount: (existing.discount ?? Money.zero(input.unitPrice.currency)).add(
        input.discount ?? Money.zero(input.unitPrice.currency),
      ),
    });
  }

  return {
    lines: order.flatMap((key) => {
      const line = byKey.get(key);
      return line === undefined ? [] : [line];
    }),
    mergedProductIds: [...mergedProductIds],
  };
}

function parseTaxRate(rate: string, lineNumber: number): Result<number, DomainError> {
  const parsed = Number.parseFloat(rate);
  if (!Number.isFinite(parsed)) {
    return err(
      DomainErrors.invalidFormat('نسبة الضريبة', 'tax rate', '15.00', 'taxRate'),
    );
  }
  if (parsed < 0 || parsed > 100) {
    return err(
      DomainErrors.validation(
        `البند رقم ${lineNumber}: نسبة الضريبة يجب أن تكون بين 0 و 100.`,
        `Line ${lineNumber}: the tax rate must be between 0 and 100.`,
        'taxRate',
      ),
    );
  }
  return ok(parsed);
}

/**
 * Distributes a header-level (invoice-wide) discount across lines proportionally
 * to their gross amount, then recalculates tax.
 *
 * Uses exact allocation, so the sum of the line discounts equals the header
 * discount to the halala — no residue, no "total doesn't match" on the XML.
 */
export function applyHeaderDiscount(
  invoice: CalculatedInvoice,
  headerDiscount: Money,
  currency: string,
): Result<CalculatedInvoice, DomainError> {
  if (headerDiscount.isNegative) {
    return err(
      DomainErrors.validation(
        'الخصم الإجمالي لا يمكن أن يكون سالباً.',
        'The header discount cannot be negative.',
        'discountTotal',
      ),
    );
  }

  if (headerDiscount.greaterThan(invoice.subtotal)) {
    return err(
      DomainErrors.validation(
        `الخصم الإجمالي (${headerDiscount.toFixed(2)}) يتجاوز إجمالي الفاتورة (${invoice.subtotal.toFixed(2)}).`,
        `The header discount (${headerDiscount.toFixed(2)}) exceeds the invoice subtotal (${invoice.subtotal.toFixed(2)}).`,
        'discountTotal',
      ),
    );
  }

  const weights = invoice.lines.map((line) => line.grossAmount.toScaled());
  const shares = headerDiscount.allocate(weights);

  const lines = invoice.lines.map((line, index) => {
    const extraDiscount = shares[index] ?? Money.zero(currency);
    const discount = line.discount.add(extraDiscount);
    const netAmount = line.grossAmount.subtract(discount);
    const taxAmount = netAmount.percentage(line.taxRate).round(2);
    return {
      ...line,
      discount,
      netAmount,
      taxAmount,
      lineTotal: netAmount.add(taxAmount),
    };
  });

  const subtotal = Money.sum(lines.map((line) => line.grossAmount), currency);
  const discountTotal = Money.sum(lines.map((line) => line.discount), currency);
  const taxTotal = Money.sum(lines.map((line) => line.taxAmount), currency);

  return ok({
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal.subtract(discountTotal).add(taxTotal),
    mergedProductIds: invoice.mergedProductIds,
  });
}
