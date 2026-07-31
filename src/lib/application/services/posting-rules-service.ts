import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { REQUIRED_MAPPING_KEYS } from '@/lib/domain/accounting/account-mapping';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * Automatic posting rules — the account each kind of transaction posts to.
 *
 * This is the table every posting path resolves against. `SALES_REVENUE` is where an invoice's
 * net amount lands, `INVENTORY_ADJUSTMENT` is where a count variance lands, `AR_CONTROL` is the
 * receivable an invoice raises. Changing one here changes where *future* postings go.
 *
 * ## Changing a mapping does not move what already posted
 *
 * It cannot, and pretending otherwise would be worse than the limitation. A journal line names
 * an account; the mapping is only how that account was chosen at the time. Re-pointing
 * `SALES_REVENUE` at a different account leaves last year's revenue where it is — which is
 * correct, because last year's revenue *was* posted there and the trial balance has been
 * signed off on that basis. The screen says so rather than leaving it to be discovered.
 *
 * ## Why the missing keys are the headline
 *
 * `REQUIRED_MAPPING_KEYS` lists what the system cannot post without. A tenant missing
 * `VAT_OUTPUT` does not find out at configuration time; it finds out when the first invoice
 * with tax on it refuses to post, halfway through a month-end. Surfacing the gaps as the first
 * thing on the screen is the whole reason this screen is worth having.
 */

export interface PostingRuleRow {
  readonly key: string;
  readonly labelAr: string;
  readonly required: boolean;
  /** `null` when the key is unmapped — which for a required key is a defect, not a blank. */
  readonly mappingId: string | null;
  readonly accountId: string | null;
  readonly accountCode: string | null;
  readonly accountNameAr: string | null;
}

/**
 * Arabic labels for the mapping keys.
 *
 * A map rather than a switch so an unlabelled key degrades to its own name instead of
 * vanishing: a key added to the domain and not to this file still appears on the screen.
 */
const KEY_LABELS_AR: Record<string, string> = {
  AR_CONTROL: 'ذمم العملاء (المدينون)',
  AP_CONTROL: 'ذمم الموردين (الدائنون)',
  VAT_OUTPUT: 'ضريبة القيمة المضافة — المخرجات',
  VAT_INPUT: 'ضريبة القيمة المضافة — المدخلات',
  SALES_REVENUE: 'إيرادات المبيعات',
  SALES_DISCOUNT: 'خصم المبيعات',
  SALES_RETURNS: 'مرتجعات المبيعات',
  COGS: 'تكلفة البضاعة المباعة',
  INVENTORY: 'المخزون',
  INVENTORY_ADJUSTMENT: 'تسويات وفروقات المخزون',
  PURCHASE_EXPENSE: 'مصروف المشتريات',
  CASH: 'الصندوق',
  BANK: 'البنك',
  FX_GAIN: 'أرباح فروق العملة',
  FX_LOSS: 'خسائر فروق العملة',
  ROUNDING_DIFFERENCE: 'فروق التقريب',
  SALARIES_EXPENSE: 'مصروف الرواتب',
  SALARIES_PAYABLE: 'الرواتب المستحقة',
  EMPLOYEE_DEDUCTIONS_PAYABLE: 'استقطاعات الموظفين المستحقة',
  DEPRECIATION_EXPENSE: 'مصروف الإهلاك',
  ACCUMULATED_DEPRECIATION: 'مجمع الإهلاك',
  RETAINED_EARNINGS: 'الأرباح المبقاة',
  OPENING_BALANCE_EQUITY: 'رصيد افتتاحي — حقوق الملكية',
};

export async function listPostingRules(tenantId: string): Promise<PostingRuleRow[]> {
  return withTenantRead(async (tx) => {
    // Tenant defaults only: `branchId`/`categoryId` narrowing exists in the schema and is not
    // editable here. A screen that let one branch override `SALES_REVENUE` without showing the
    // resolution order would be a way to configure a surprise.
    const mappings = await tx.accountMapping.findMany({
      where: { tenantId, branchId: null, categoryId: null },
      select: {
        id: true,
        key: true,
        accountId: true,
        account: { select: { code: true, nameAr: true } },
      },
    });

    const byKey = new Map(mappings.map((mapping) => [mapping.key, mapping]));

    // Every required key appears, mapped or not — an absent row is the finding.
    const keys = [...new Set([...REQUIRED_MAPPING_KEYS, ...mappings.map((m) => m.key)])];
    keys.sort((a, b) => a.localeCompare(b));

    return keys.map((key) => {
      const mapping = byKey.get(key);
      return {
        key,
        labelAr: KEY_LABELS_AR[key] ?? key,
        required: (REQUIRED_MAPPING_KEYS as readonly string[]).includes(key),
        mappingId: mapping?.id ?? null,
        accountId: mapping?.accountId ?? null,
        accountCode: mapping?.account.code ?? null,
        accountNameAr: mapping?.account.nameAr ?? null,
      };
    });
  });
}

/**
 * Points a key at an account, creating the mapping if it did not exist.
 *
 * The target must be postable. A mapping onto a header account produces journal lines the
 * ledger refuses at post time, which surfaces as an invoice that will not save for a reason
 * that names an account nobody chose deliberately.
 */
export async function setPostingRule(input: {
  tenantId: string;
  audit: AuditContext;
  key: string;
  accountId: string;
}): Promise<Result<{ key: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: input.accountId, tenantId: input.tenantId },
      select: { id: true, code: true, nameAr: true, isPostable: true, isActive: true },
    });

    if (account === null) {
      return err(DomainErrors.notFound('الحساب', 'Account', input.accountId));
    }

    if (!account.isPostable) {
      return err(
        DomainErrors.validation(
          `الحساب ${account.code} حساب تجميعي ولا يقبل الترحيل المباشر.`,
          'That account is a header and cannot be posted to.',
          'accountId',
        ),
      );
    }

    if (!account.isActive) {
      return err(
        DomainErrors.validation(
          `الحساب ${account.code} موقوف.`,
          'That account is inactive.',
          'accountId',
        ),
      );
    }

    const existing = await tx.accountMapping.findFirst({
      where: { tenantId: input.tenantId, key: input.key, branchId: null, categoryId: null },
      select: { id: true, accountId: true },
    });

    if (existing === null) {
      await tx.accountMapping.create({
        data: { tenantId: input.tenantId, key: input.key, accountId: account.id },
      });
    } else {
      await tx.accountMapping.update({
        where: { id: existing.id },
        data: { accountId: account.id },
      });
    }

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'accountMapping', entityId: existing?.id ?? input.key },
      {
        metadata: {
          key: input.key,
          fromAccountId: existing?.accountId ?? null,
          toAccountId: account.id,
          toAccountCode: account.code,
        },
      },
    );

    return ok({ key: input.key });
  });
}

/** Postable accounts, for the picker. Header accounts are excluded rather than shown greyed. */
export async function listPostableAccounts(
  tenantId: string,
): Promise<{ id: string; code: string; nameAr: string }[]> {
  return withTenantRead(async (tx) =>
    tx.account.findMany({
      where: { tenantId, isPostable: true, isActive: true },
      select: { id: true, code: true, nameAr: true },
      orderBy: { code: 'asc' },
    }),
  );
}
