import { calculateInvoice } from '@/lib/domain/sales/invoice-calculator';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';

/**
 * Adapts half-typed form input to the invoice calculator.
 *
 * The totals on the entry form are computed by `calculateInvoice` — the same
 * function the API uses — rather than by arithmetic written again in the component.
 * Two implementations of the same tax and discount rules would agree right up until
 * they did not, and the one the user watched while deciding to save is the one they
 * would believe.
 *
 * What stands between the two is this module. `Money.of` and `Quantity.of` throw on
 * anything unparseable, and a form field is unparseable constantly: it is empty
 * before it is filled and it is `"12."` in the middle of typing `"12.5"`. So every
 * value is screened first and an incomplete line is *excluded* from the running
 * total rather than allowed to throw or to count as zero.
 *
 * Excluded rather than zero because they read differently. A line still being typed
 * contributes nothing to a subtotal; a line worth zero contributes zero and is a
 * line the calculator should refuse.
 */

export interface DraftLine {
  readonly id: string;
  readonly productId: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  readonly taxRate: string;
  readonly descriptionAr: string;
}

export interface DraftTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly total: string;
  /** Lines that were complete enough to count. */
  readonly countedLines: number;
  /** Lines skipped because they are still being filled in. */
  readonly incompleteLines: number;
}

/** Scale-4 decimal, unsigned — what the API's own regexes accept. */
const AMOUNT = /^\d+(\.\d{1,4})?$/;
const RATE = /^\d+(\.\d{1,2})?$/;

export function isAmount(value: string): boolean {
  return AMOUNT.test(value.trim());
}

export function isRate(value: string): boolean {
  const trimmed = value.trim();
  if (!RATE.test(trimmed)) return false;
  const numeric = Number(trimmed);
  return numeric >= 0 && numeric <= 100;
}

/**
 * True when a line has everything the calculator needs.
 *
 * Discount is optional and defaults to zero; a blank one is complete, not missing.
 */
export function isLineComplete(line: DraftLine): boolean {
  if (line.productId === '') return false;
  if (!isAmount(line.quantity) || Number(line.quantity) <= 0) return false;
  if (!isAmount(line.unitPrice)) return false;
  if (line.discount.trim() !== '' && !isAmount(line.discount)) return false;
  if (!isRate(line.taxRate)) return false;
  return true;
}

const EMPTY: DraftTotals = {
  subtotal: '0.00',
  discountTotal: '0.00',
  taxTotal: '0.00',
  total: '0.00',
  countedLines: 0,
  incompleteLines: 0,
};

/**
 * The running totals for a draft, or the reason there are none.
 *
 * Returns a message rather than throwing when the calculator refuses — a discount
 * larger than its line is a legitimate thing to type on the way to fixing it, and a
 * form that crashes on it is worse than one that says so.
 */
export function summariseDraft(
  lines: readonly DraftLine[],
  currency: string,
): { ok: true; totals: DraftTotals } | { ok: false; message: string } {
  const complete = lines.filter(isLineComplete);
  const incompleteLines = lines.length - complete.length;

  if (complete.length === 0) {
    return { ok: true, totals: { ...EMPTY, incompleteLines } };
  }

  const calculated = calculateInvoice(
    complete.map((line) => ({
      productId: line.productId,
      quantity: Quantity.of(line.quantity.trim()),
      unitPrice: Money.of(line.unitPrice.trim(), currency),
      discount: Money.of(line.discount.trim() === '' ? '0' : line.discount.trim(), currency),
      taxRate: line.taxRate.trim(),
      ...(line.descriptionAr.trim() !== '' ? { descriptionAr: line.descriptionAr.trim() } : {}),
    })),
    { currency },
  );

  if (!calculated.ok) {
    return { ok: false, message: calculated.error.messageAr };
  }

  return {
    ok: true,
    totals: {
      subtotal: calculated.value.subtotal.toFixed(2),
      discountTotal: calculated.value.discountTotal.toFixed(2),
      taxTotal: calculated.value.taxTotal.toFixed(2),
      total: calculated.value.total.toFixed(2),
      countedLines: complete.length,
      incompleteLines,
    },
  };
}

/** The payload shape `POST /api/sales/invoices` expects, from complete lines only. */
export function toApiLines(
  lines: readonly DraftLine[],
): {
  productId: string;
  quantity: string;
  unitPrice: string;
  discount?: string;
  taxRate: string;
  descriptionAr?: string;
}[] {
  return lines.filter(isLineComplete).map((line) => ({
    productId: line.productId,
    quantity: line.quantity.trim(),
    unitPrice: line.unitPrice.trim(),
    ...(line.discount.trim() !== '' && Number(line.discount) > 0
      ? { discount: line.discount.trim() }
      : {}),
    taxRate: line.taxRate.trim(),
    ...(line.descriptionAr.trim() !== '' ? { descriptionAr: line.descriptionAr.trim() } : {}),
  }));
}
