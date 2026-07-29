import type { AccountMappingKey } from '../../src/lib/domain/accounting/account-mapping';

/**
 * The default chart of accounts.
 *
 * Structured the way a Saudi trading company's chart actually is: a numeric
 * hierarchy where the first digit is the statement classification, summary
 * levels are not postable, and the sub-ledger control accounts are explicitly
 * marked so that nothing can post to receivables except the receivables module.
 *
 * Contra accounts (accumulated depreciation, sales returns, discounts allowed)
 * keep their parent's type and invert only their nature — see migration 003.
 */

export interface AccountTemplate {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  readonly nature: 'DEBIT' | 'CREDIT';
  readonly isPostable: boolean;
  readonly isControl?: boolean;
  readonly isContra?: boolean;
  /** Mapping key this account fulfils, if any. */
  readonly mappingKey?: AccountMappingKey;
}

export const CHART_OF_ACCOUNTS: readonly AccountTemplate[] = [
  // ── 1 Assets ──────────────────────────────────────────────────────────────
  { code: '1', nameAr: 'الأصول', nameEn: 'Assets', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1', nameAr: 'الأصول المتداولة', nameEn: 'Current Assets', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-01', nameAr: 'النقدية وما في حكمها', nameEn: 'Cash and Cash Equivalents', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-01-001', nameAr: 'الصندوق الرئيسي', nameEn: 'Main Cash Account', type: 'ASSET', nature: 'DEBIT', isPostable: true, mappingKey: 'CASH' },
  { code: '1-1-01-002', nameAr: 'صندوق المصروفات النثرية', nameEn: 'Petty Cash', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-1-02', nameAr: 'البنوك', nameEn: 'Banks', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-02-001', nameAr: 'البنك الأهلي - حساب جاري', nameEn: 'NCB - Current Account', type: 'ASSET', nature: 'DEBIT', isPostable: true, mappingKey: 'BANK' },
  { code: '1-1-02-002', nameAr: 'مصرف الراجحي - حساب جاري', nameEn: 'Al Rajhi - Current Account', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-1-03', nameAr: 'الذمم المدينة', nameEn: 'Receivables', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-03-001', nameAr: 'ذمم العملاء', nameEn: 'Trade Receivables', type: 'ASSET', nature: 'DEBIT', isPostable: true, isControl: true, mappingKey: 'AR_CONTROL' },
  { code: '1-1-03-002', nameAr: 'ذمم موظفين', nameEn: 'Employee Receivables', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-1-04', nameAr: 'المخزون', nameEn: 'Inventory', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-04-001', nameAr: 'مخزون البضاعة', nameEn: 'Merchandise Inventory', type: 'ASSET', nature: 'DEBIT', isPostable: true, isControl: true, mappingKey: 'INVENTORY' },
  { code: '1-1-05', nameAr: 'ضرائب مدفوعة مقدماً', nameEn: 'Prepaid Taxes', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-05-001', nameAr: 'ضريبة القيمة المضافة - مدخلات', nameEn: 'VAT Input (Recoverable)', type: 'ASSET', nature: 'DEBIT', isPostable: true, mappingKey: 'VAT_INPUT' },
  { code: '1-1-06', nameAr: 'مصروفات مدفوعة مقدماً', nameEn: 'Prepaid Expenses', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-1-06-001', nameAr: 'إيجارات مدفوعة مقدماً', nameEn: 'Prepaid Rent', type: 'ASSET', nature: 'DEBIT', isPostable: true },

  { code: '1-2', nameAr: 'الأصول الثابتة', nameEn: 'Fixed Assets', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-2-01', nameAr: 'الأصول الثابتة بالتكلفة', nameEn: 'Fixed Assets at Cost', type: 'ASSET', nature: 'DEBIT', isPostable: false },
  { code: '1-2-01-001', nameAr: 'أثاث ومعدات مكتبية', nameEn: 'Furniture and Office Equipment', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-2-01-002', nameAr: 'أجهزة حاسب آلي', nameEn: 'Computer Equipment', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-2-01-003', nameAr: 'سيارات ومركبات', nameEn: 'Vehicles', type: 'ASSET', nature: 'DEBIT', isPostable: true },
  { code: '1-2-02', nameAr: 'مجمع الإهلاك', nameEn: 'Accumulated Depreciation', type: 'ASSET', nature: 'CREDIT', isPostable: false, isContra: true },
  { code: '1-2-02-001', nameAr: 'مجمع إهلاك الأثاث والمعدات', nameEn: 'Accumulated Depreciation - Furniture', type: 'ASSET', nature: 'CREDIT', isPostable: true, isContra: true, mappingKey: 'ACCUMULATED_DEPRECIATION' },
  { code: '1-2-02-002', nameAr: 'مجمع إهلاك أجهزة الحاسب', nameEn: 'Accumulated Depreciation - Computers', type: 'ASSET', nature: 'CREDIT', isPostable: true, isContra: true },
  { code: '1-2-02-003', nameAr: 'مجمع إهلاك السيارات', nameEn: 'Accumulated Depreciation - Vehicles', type: 'ASSET', nature: 'CREDIT', isPostable: true, isContra: true },

  // ── 2 Liabilities ─────────────────────────────────────────────────────────
  { code: '2', nameAr: 'الالتزامات', nameEn: 'Liabilities', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1', nameAr: 'الالتزامات المتداولة', nameEn: 'Current Liabilities', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1-01', nameAr: 'الذمم الدائنة', nameEn: 'Payables', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1-01-001', nameAr: 'ذمم الموردين', nameEn: 'Trade Payables', type: 'LIABILITY', nature: 'CREDIT', isPostable: true, isControl: true, mappingKey: 'AP_CONTROL' },
  { code: '2-1-02', nameAr: 'ضرائب مستحقة', nameEn: 'Taxes Payable', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1-02-001', nameAr: 'ضريبة القيمة المضافة - مخرجات', nameEn: 'VAT Output (Payable)', type: 'LIABILITY', nature: 'CREDIT', isPostable: true, mappingKey: 'VAT_OUTPUT' },
  { code: '2-1-02-002', nameAr: 'الزكاة المستحقة', nameEn: 'Zakat Payable', type: 'LIABILITY', nature: 'CREDIT', isPostable: true },
  { code: '2-1-03', nameAr: 'مستحقات الموظفين', nameEn: 'Employee Liabilities', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1-03-001', nameAr: 'رواتب مستحقة الدفع', nameEn: 'Salaries Payable', type: 'LIABILITY', nature: 'CREDIT', isPostable: true, mappingKey: 'SALARIES_PAYABLE' },
  { code: '2-1-03-002', nameAr: 'استقطاعات الموظفين المستحقة', nameEn: 'Employee Deductions Payable', type: 'LIABILITY', nature: 'CREDIT', isPostable: true, mappingKey: 'EMPLOYEE_DEDUCTIONS_PAYABLE' },
  { code: '2-1-03-003', nameAr: 'مكافأة نهاية الخدمة', nameEn: 'End of Service Benefits', type: 'LIABILITY', nature: 'CREDIT', isPostable: true },
  { code: '2-1-04', nameAr: 'مصروفات مستحقة', nameEn: 'Accrued Expenses', type: 'LIABILITY', nature: 'CREDIT', isPostable: false },
  { code: '2-1-04-001', nameAr: 'مصروفات مستحقة أخرى', nameEn: 'Other Accrued Expenses', type: 'LIABILITY', nature: 'CREDIT', isPostable: true },

  // ── 3 Equity ──────────────────────────────────────────────────────────────
  { code: '3', nameAr: 'حقوق الملكية', nameEn: 'Equity', type: 'EQUITY', nature: 'CREDIT', isPostable: false },
  { code: '3-1', nameAr: 'رأس المال والاحتياطيات', nameEn: 'Capital and Reserves', type: 'EQUITY', nature: 'CREDIT', isPostable: false },
  { code: '3-1-01-001', nameAr: 'رأس المال المدفوع', nameEn: 'Paid-in Capital', type: 'EQUITY', nature: 'CREDIT', isPostable: true, mappingKey: 'OPENING_BALANCE_EQUITY' },
  { code: '3-1-02-001', nameAr: 'الاحتياطي النظامي', nameEn: 'Statutory Reserve', type: 'EQUITY', nature: 'CREDIT', isPostable: true },
  { code: '3-1-03-001', nameAr: 'الأرباح المبقاة', nameEn: 'Retained Earnings', type: 'EQUITY', nature: 'CREDIT', isPostable: true, mappingKey: 'RETAINED_EARNINGS' },

  // ── 4 Revenue ─────────────────────────────────────────────────────────────
  { code: '4', nameAr: 'الإيرادات', nameEn: 'Revenue', type: 'REVENUE', nature: 'CREDIT', isPostable: false },
  { code: '4-1', nameAr: 'إيرادات النشاط الرئيسي', nameEn: 'Operating Revenue', type: 'REVENUE', nature: 'CREDIT', isPostable: false },
  { code: '4-1-01-001', nameAr: 'إيرادات المبيعات', nameEn: 'Sales Revenue', type: 'REVENUE', nature: 'CREDIT', isPostable: true, mappingKey: 'SALES_REVENUE' },
  { code: '4-1-02-001', nameAr: 'إيرادات الخدمات', nameEn: 'Service Revenue', type: 'REVENUE', nature: 'CREDIT', isPostable: true },
  { code: '4-2', nameAr: 'مردودات وخصومات المبيعات', nameEn: 'Sales Returns and Discounts', type: 'REVENUE', nature: 'DEBIT', isPostable: false, isContra: true },
  { code: '4-2-01-001', nameAr: 'الخصم المسموح به', nameEn: 'Discounts Allowed', type: 'REVENUE', nature: 'DEBIT', isPostable: true, isContra: true, mappingKey: 'SALES_DISCOUNT' },
  { code: '4-2-02-001', nameAr: 'مردودات المبيعات', nameEn: 'Sales Returns', type: 'REVENUE', nature: 'DEBIT', isPostable: true, isContra: true, mappingKey: 'SALES_RETURNS' },
  { code: '4-9', nameAr: 'إيرادات أخرى', nameEn: 'Other Income', type: 'REVENUE', nature: 'CREDIT', isPostable: false },
  { code: '4-9-01-001', nameAr: 'أرباح فروق العملة', nameEn: 'Foreign Exchange Gains', type: 'REVENUE', nature: 'CREDIT', isPostable: true, mappingKey: 'FX_GAIN' },
  { code: '4-9-02-001', nameAr: 'إيرادات متنوعة', nameEn: 'Miscellaneous Income', type: 'REVENUE', nature: 'CREDIT', isPostable: true },

  // ── 5 Expenses ────────────────────────────────────────────────────────────
  { code: '5', nameAr: 'المصروفات', nameEn: 'Expenses', type: 'EXPENSE', nature: 'DEBIT', isPostable: false },
  { code: '5-1', nameAr: 'تكلفة الإيرادات', nameEn: 'Cost of Revenue', type: 'EXPENSE', nature: 'DEBIT', isPostable: false },
  { code: '5-1-01-001', nameAr: 'تكلفة البضاعة المباعة', nameEn: 'Cost of Goods Sold', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'COGS' },
  { code: '5-1-02-001', nameAr: 'مشتريات خدمية ومصروفات مباشرة', nameEn: 'Purchased Services and Direct Costs', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'PURCHASE_EXPENSE' },
  { code: '5-1-03-001', nameAr: 'تسويات وفروقات المخزون', nameEn: 'Inventory Adjustments', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'INVENTORY_ADJUSTMENT' },

  { code: '5-2', nameAr: 'مصروفات الموظفين', nameEn: 'Employee Costs', type: 'EXPENSE', nature: 'DEBIT', isPostable: false },
  { code: '5-2-01-001', nameAr: 'الرواتب والأجور', nameEn: 'Salaries and Wages', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'SALARIES_EXPENSE' },
  { code: '5-2-02-001', nameAr: 'التأمينات الاجتماعية - حصة المنشأة', nameEn: 'GOSI - Employer Share', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-2-03-001', nameAr: 'مكافآت وحوافز', nameEn: 'Bonuses and Incentives', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },

  { code: '5-3', nameAr: 'مصروفات عمومية وإدارية', nameEn: 'General and Administrative', type: 'EXPENSE', nature: 'DEBIT', isPostable: false },
  { code: '5-3-01-001', nameAr: 'إيجارات', nameEn: 'Rent', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-02-001', nameAr: 'كهرباء ومياه', nameEn: 'Utilities', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-03-001', nameAr: 'اتصالات وإنترنت', nameEn: 'Communications', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-04-001', nameAr: 'صيانة وإصلاحات', nameEn: 'Maintenance and Repairs', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-05-001', nameAr: 'تسويق وإعلان', nameEn: 'Marketing and Advertising', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-06-001', nameAr: 'سفر وانتقالات', nameEn: 'Travel and Transportation', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-07-001', nameAr: 'تأمين', nameEn: 'Insurance', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-08-001', nameAr: 'رسوم حكومية', nameEn: 'Government Fees', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-09-001', nameAr: 'نظافة وأمن', nameEn: 'Cleaning and Security', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
  { code: '5-3-10-001', nameAr: 'مصروف الإهلاك', nameEn: 'Depreciation Expense', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'DEPRECIATION_EXPENSE' },

  { code: '5-9', nameAr: 'مصروفات أخرى', nameEn: 'Other Expenses', type: 'EXPENSE', nature: 'DEBIT', isPostable: false },
  { code: '5-9-01-001', nameAr: 'خسائر فروق العملة', nameEn: 'Foreign Exchange Losses', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'FX_LOSS' },
  { code: '5-9-02-001', nameAr: 'فروقات التقريب', nameEn: 'Rounding Differences', type: 'EXPENSE', nature: 'DEBIT', isPostable: true, mappingKey: 'ROUNDING_DIFFERENCE' },
  { code: '5-9-03-001', nameAr: 'مصروفات بنكية', nameEn: 'Bank Charges', type: 'EXPENSE', nature: 'DEBIT', isPostable: true },
];

/** General-expense accounts the journal generator posts random entries against. */
export const GENERAL_EXPENSE_CODES: readonly string[] = [
  '5-3-01-001',
  '5-3-02-001',
  '5-3-03-001',
  '5-3-04-001',
  '5-3-05-001',
  '5-3-06-001',
  '5-3-07-001',
  '5-3-08-001',
  '5-3-09-001',
  '5-9-03-001',
];

/**
 * Derives a parent code from a child's.
 *
 * `1-1-03-001` -> `1-1-03` -> `1-1` -> `1`. Codes whose immediate parent is not
 * itself in the chart (e.g. `3-1-01-001`, where `3-1-01` does not exist) walk up
 * until they find one, which keeps the tree connected without demanding that
 * every intermediate level be spelled out.
 */
export function findParentCode(code: string, allCodes: ReadonlySet<string>): string | null {
  const segments = code.split('-');
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const candidate = segments.slice(0, depth).join('-');
    if (allCodes.has(candidate)) return candidate;
  }
  return null;
}
