import type { TaxTreatment } from '@prisma/client';

/**
 * Tax vocabulary, in a module a client component may import.
 *
 * Separate from `tax-code-service.ts` for a mechanical reason: importing a *value* from that
 * service into a `'use client'` file pulls in `prisma.ts`, which imports `node:async_hooks`,
 * which webpack cannot bundle for the browser. The build fails with an `UnhandledSchemeError`
 * naming neither file. These are pure data, so they live where both sides can reach them —
 * the same split as `zatca-labels.ts`.
 */

export const TREATMENTS: readonly TaxTreatment[] = [
  'STANDARD',
  'ZERO_RATED',
  'EXEMPT',
  'OUT_OF_SCOPE',
];

export const TREATMENT_LABELS_AR: Record<TaxTreatment, string> = {
  STANDARD: 'خاضعة للضريبة',
  ZERO_RATED: 'خاضعة بنسبة صفر',
  EXEMPT: 'معفاة',
  OUT_OF_SCOPE: 'خارج نطاق الضريبة',
};

/** What each treatment means in practice, said on the screen so nobody has to guess. */
export const TREATMENT_NOTES_AR: Record<TaxTreatment, string> = {
  STANDARD: 'توريد خاضع للضريبة بالنسبة الأساسية. يظهر في الإقرار الضريبي.',
  ZERO_RATED:
    'توريد خاضع للضريبة لكن بنسبة صفر — كالتصدير. يظهر في الإقرار، ويختلف عن المعفى.',
  EXEMPT: 'توريد غير خاضع للضريبة أصلاً — كالإيجار السكني. لا يظهر ضمن المبيعات الخاضعة.',
  OUT_OF_SCOPE: 'خارج نطاق ضريبة القيمة المضافة السعودية بالكامل.',
};

/**
 * The letter ZATCA writes into `cac:ClassifiedTaxCategory`.
 *
 * Duplicated from the CHECK constraint in migration 017 on purpose: the constraint is the
 * guarantee and this is the label. `tests/unit/tax-codes.test.ts` asserts the two agree, so a
 * change to one that is not made to the other fails rather than drifts.
 */
export const ZATCA_CATEGORY: Record<TaxTreatment, string> = {
  STANDARD: 'S',
  ZERO_RATED: 'Z',
  EXEMPT: 'E',
  OUT_OF_SCOPE: 'O',
};

/** A tax code as the screens read it. Decimals are strings — the client does exact arithmetic. */
export interface TaxCodeRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly treatment: TaxTreatment;
  /** Percent as a plain string, e.g. `"15.00"`. */
  readonly rate: string;
  readonly zatcaCode: string;
  readonly exemptionReasonAr: string | null;
  readonly exemptionReasonCode: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
}
