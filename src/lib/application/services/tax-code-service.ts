import type { TaxTreatment } from '@prisma/client';
import { ZATCA_CATEGORY, type TaxCodeRow } from '@/lib/commercial/tax-labels';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';

/**
 * VAT treatments the tenant can put on an invoice line.
 *
 * ## Rate and treatment are one decision, not two
 *
 * The obvious shape is "name + rate", and it is wrong. Zero-rated and exempt are both 0%, but
 * a zero-rated supply belongs in the VAT return and an exempt one does not, and ZATCA writes a
 * different category letter for each. Storing only the rate throws that away at the moment it
 * is entered, and no later screen can recover it.
 *
 * So the treatment is chosen and everything else follows: the rate is forced to 0 for anything
 * non-standard, the ZATCA letter is derived, and a reason is demanded. All three are also CHECK
 * constraints, because a service-level rule is one that any other writer bypasses.
 */

export {
  TREATMENTS,
  TREATMENT_LABELS_AR,
  TREATMENT_NOTES_AR,
  ZATCA_CATEGORY,
  type TaxCodeRow,
} from '@/lib/commercial/tax-labels';

export async function listTaxCodes(
  tenantId: string,
  options: { readonly activeOnly?: boolean } = {},
): Promise<TaxCodeRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.taxCode.findMany({
      where: { tenantId, ...(options.activeOnly === true ? { isActive: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      treatment: row.treatment,
      rate: row.rate.toFixed(2),
      zatcaCode: row.zatcaCode,
      exemptionReasonAr: row.exemptionReasonAr,
      exemptionReasonCode: row.exemptionReasonCode,
      isDefault: row.isDefault,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    }));
  });
}

/**
 * The rate a new invoice line starts at.
 *
 * Falls back to `15.00` only when the tenant has no active default at all — which migration 017
 * makes impossible for an existing tenant and the seed makes impossible for a new one, but a
 * form that renders an empty rate box is the failure this whole release is about, so the
 * fallback is a constant rather than a blank.
 */
export async function getDefaultTaxRate(tenantId: string): Promise<string> {
  return withTenantRead(async (tx) => {
    const row = await tx.taxCode.findFirst({
      where: { tenantId, isDefault: true, isActive: true },
      select: { rate: true },
    });
    return (row?.rate ?? null)?.toFixed(2) ?? '15.00';
  });
}

export interface SaveTaxCodeInput {
  readonly tenantId: string;
  readonly audit: AuditContext;
  /** Absent creates; present updates. */
  readonly id?: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly treatment: TaxTreatment;
  /** Ignored for anything but STANDARD, which is forced to 0. */
  readonly rate: string;
  readonly exemptionReasonAr?: string | null;
  readonly exemptionReasonCode?: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export async function saveTaxCode(
  input: SaveTaxCodeInput,
): Promise<Result<{ id: string }, DomainError>> {
  const code = input.code.trim().toUpperCase();

  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
    return err(
      DomainErrors.invalidFormat('رمز الضريبة', 'tax code', 'VAT15', 'code'),
    );
  }

  if (input.nameAr.trim() === '') {
    return err(DomainErrors.requiredField('الاسم بالعربية', 'Arabic name', 'nameAr'));
  }

  const standard = input.treatment === 'STANDARD';

  // Non-standard treatments are 0 by definition, so the typed rate is discarded rather than
  // validated. Rejecting "zero-rated at 15%" with an error message would be technically
  // correct and practically pointless: there is only one rate it could have meant.
  const rate = standard ? Number.parseFloat(input.rate) : 0;

  if (standard && (!Number.isFinite(rate) || rate <= 0 || rate > 100)) {
    return err(
      DomainErrors.outOfRange('نسبة الضريبة', 'tax rate', '0', '100', 'rate'),
    );
  }

  const reason = input.exemptionReasonAr?.trim() ?? '';

  if (!standard && reason === '') {
    return err(
      DomainErrors.validation(
        'التوريد غير الخاضع للنسبة الأساسية يحتاج سبباً — الهيئة ترفض الفاتورة التي لا تذكر لماذا لم تُحتسب عليها ضريبة.',
        'A non-standard treatment requires a stated exemption reason.',
        'exemptionReasonAr',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const existing =
      input.id === undefined
        ? null
        : await tx.taxCode.findFirst({ where: { id: input.id, tenantId: input.tenantId } });

    if (input.id !== undefined && existing === null) {
      return err(DomainErrors.notFound('رمز الضريبة', 'Tax code', input.id));
    }

    const clash = await tx.taxCode.findFirst({
      where: { tenantId: input.tenantId, code, ...(existing !== null ? { NOT: { id: existing.id } } : {}) },
      select: { id: true },
    });

    if (clash !== null) {
      return err(DomainErrors.alreadyExists('رمز الضريبة', 'Tax code', code));
    }

    // Deactivating the default would leave the tenant with none, and the next invoice form
    // would open with an empty rate. Refused here rather than repaired silently, because
    // "which code should become the default instead?" is not ours to answer.
    if (existing?.isDefault === true && !input.isActive) {
      return err(
        DomainErrors.validation(
          'لا يمكن تعطيل الرمز الافتراضي. عيِّن رمزاً افتراضياً آخر أولاً.',
          'The default tax code cannot be deactivated; set another default first.',
          'isActive',
        ),
      );
    }

    const data = {
      code,
      nameAr: input.nameAr.trim(),
      nameEn: input.nameEn.trim(),
      treatment: input.treatment,
      rate: rate.toFixed(2),
      zatcaCode: ZATCA_CATEGORY[input.treatment],
      exemptionReasonAr: standard ? null : reason,
      exemptionReasonCode: standard ? null : (input.exemptionReasonCode?.trim() || null),
      isActive: input.isActive,
      sortOrder: input.sortOrder,
      updatedAt: new Date(),
    };

    const saved =
      existing === null
        ? await tx.taxCode.create({
            data: { tenantId: input.tenantId, ...data },
            select: { id: true },
          })
        : await tx.taxCode.update({
            where: { id: existing.id },
            data,
            select: { id: true },
          });

    await recordAudit(
      tx,
      input.audit,
      existing === null ? 'CREATE' : 'UPDATE',
      { entityType: 'taxCode', entityId: saved.id },
      { metadata: { code, treatment: input.treatment, rate: data.rate, isActive: input.isActive } },
    );

    return ok(saved);
  });
}

/**
 * Moves the default.
 *
 * Two statements inside one transaction, in this order: clear, then set. The reverse order
 * trips the partial unique index the instant the second default exists, which is the index
 * doing its job — but it means the "obvious" implementation fails on every call.
 */
export async function setDefaultTaxCode(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const target = await tx.taxCode.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: { id: true, code: true, isActive: true },
    });

    if (target === null) {
      return err(DomainErrors.notFound('رمز الضريبة', 'Tax code', input.id));
    }

    if (!target.isActive) {
      return err(
        DomainErrors.validation(
          'لا يمكن جعل رمز معطَّل هو الافتراضي — سيبدأ كل بند فاتورة برمز لا يمكن اختياره.',
          'An inactive tax code cannot be the default.',
          'id',
        ),
      );
    }

    await tx.taxCode.updateMany({
      where: { tenantId: input.tenantId, isDefault: true },
      data: { isDefault: false },
    });

    await tx.taxCode.update({ where: { id: target.id }, data: { isDefault: true } });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'taxCode', entityId: target.id },
      { metadata: { code: target.code, becameDefault: true } },
    );

    return ok({ id: target.id });
  });
}

/**
 * The Saudi standard set, for a tenant being created.
 *
 * Called by the seed and by tenant provisioning. A tenant without tax codes has an invoice form
 * with an empty rate dropdown, which is indistinguishable from a broken screen.
 */
export async function installDefaultTaxCodes(
  tx: TransactionClient,
  tenantId: string,
): Promise<void> {
  const codes = [
    {
      code: 'VAT15',
      nameAr: 'ضريبة القيمة المضافة 15%',
      nameEn: 'VAT 15%',
      treatment: 'STANDARD' as const,
      rate: '15.00',
      zatcaCode: 'S',
      exemptionReasonAr: null,
      exemptionReasonCode: null,
      isDefault: true,
      sortOrder: 10,
    },
    {
      code: 'ZERO',
      nameAr: 'معفاة بنسبة صفر (تصدير)',
      nameEn: 'Zero-rated (export)',
      treatment: 'ZERO_RATED' as const,
      rate: '0.00',
      zatcaCode: 'Z',
      exemptionReasonAr: 'توريد خاضع لنسبة الصفر — تصدير سلع خارج دول مجلس التعاون',
      exemptionReasonCode: 'VATEX-SA-32',
      isDefault: false,
      sortOrder: 20,
    },
    {
      code: 'EXEMPT',
      nameAr: 'توريد معفى من الضريبة',
      nameEn: 'Exempt supply',
      treatment: 'EXEMPT' as const,
      rate: '0.00',
      zatcaCode: 'E',
      exemptionReasonAr: 'توريد معفى من ضريبة القيمة المضافة',
      exemptionReasonCode: 'VATEX-SA-HEA',
      isDefault: false,
      sortOrder: 30,
    },
  ];

  for (const code of codes) {
    await tx.taxCode.upsert({
      where: { tenantId_code: { tenantId, code: code.code } },
      create: { tenantId, ...code },
      update: {},
    });
  }
}
