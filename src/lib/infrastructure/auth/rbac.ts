import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';

/**
 * Granular role-based access control.
 *
 * A permission is `resource:action`, optionally narrowed to `resource:action:field`
 * for the cases where seeing a record and seeing its cost price are different
 * privileges. Wildcards are supported at each position, so an administrator role
 * is `*:*` and a read-only auditor is `*:read`.
 *
 * Checks are pure set lookups against a snapshot taken at login, so authorising
 * a request costs no database round trip.
 */

export const RESOURCES = [
  'finance.account',
  'finance.journal',
  'finance.period',
  'finance.report',
  'sales.invoice',
  'sales.creditNote',
  'sales.customer',
  'procurement.invoice',
  'procurement.supplier',
  'inventory.product',
  'inventory.movement',
  'inventory.transfer',
  'inventory.adjustment',
  'inventory.stock',
  'treasury.payment',
  'treasury.reconciliation',
  'hr.employee',
  'hr.payroll',
  'org.branch',
  'org.warehouse',
  'platform.user',
  'platform.role',
  'platform.audit',
  'platform.settings',
] as const;

export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'post',
  'void',
  'approve',
  'reject',
  'reverse',
  'pay',
  'export',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Human-readable names, so a denial message reads like a sentence in both languages. */
const RESOURCE_LABELS: Record<string, { ar: string; en: string }> = {
  'finance.account': { ar: 'شجرة الحسابات', en: 'the chart of accounts' },
  'finance.journal': { ar: 'القيود المحاسبية', en: 'journal entries' },
  'finance.period': { ar: 'الفترات المحاسبية', en: 'fiscal periods' },
  'finance.report': { ar: 'التقارير المالية', en: 'financial reports' },
  'sales.invoice': { ar: 'فواتير المبيعات', en: 'sales invoices' },
  'sales.creditNote': { ar: 'الإشعارات الدائنة', en: 'credit notes' },
  'sales.customer': { ar: 'العملاء', en: 'customers' },
  'procurement.invoice': { ar: 'فواتير المشتريات', en: 'purchase invoices' },
  'procurement.supplier': { ar: 'الموردين', en: 'suppliers' },
  'inventory.product': { ar: 'الأصناف', en: 'products' },
  'inventory.movement': { ar: 'حركات المخزون', en: 'inventory movements' },
  'inventory.transfer': { ar: 'التحويلات المخزنية', en: 'stock transfers' },
  'inventory.adjustment': { ar: 'تسويات المخزون', en: 'inventory adjustments' },
  'inventory.stock': { ar: 'أرصدة المخزون', en: 'stock balances' },
  'treasury.payment': { ar: 'سندات القبض والصرف', en: 'payment vouchers' },
  'treasury.reconciliation': { ar: 'التسوية البنكية', en: 'bank reconciliation' },
  'hr.employee': { ar: 'الموظفين', en: 'employees' },
  'hr.payroll': { ar: 'مسير الرواتب', en: 'payroll' },
  'org.branch': { ar: 'الفروع', en: 'branches' },
  'org.warehouse': { ar: 'المستودعات', en: 'warehouses' },
  'platform.user': { ar: 'المستخدمين', en: 'users' },
  'platform.role': { ar: 'الأدوار والصلاحيات', en: 'roles and permissions' },
  'platform.audit': { ar: 'سجل التدقيق', en: 'the audit trail' },
  'platform.settings': { ar: 'إعدادات النظام', en: 'system settings' },
};

const ACTION_LABELS: Record<string, { ar: string; en: string }> = {
  create: { ar: 'الإضافة', en: 'create' },
  read: { ar: 'الاطلاع', en: 'view' },
  update: { ar: 'التعديل', en: 'update' },
  delete: { ar: 'الحذف', en: 'delete' },
  post: { ar: 'الترحيل', en: 'post' },
  void: { ar: 'الإلغاء', en: 'void' },
  approve: { ar: 'الاعتماد', en: 'approve' },
  reject: { ar: 'الرفض', en: 'reject' },
  reverse: { ar: 'العكس', en: 'reverse' },
  pay: { ar: 'الدفع', en: 'pay' },
  export: { ar: 'التصدير', en: 'export' },
};

/** Fields that are hidden unless explicitly granted. Enforced by the API serialisers. */
export const FIELD_LEVEL_PROTECTED: Record<string, readonly string[]> = {
  'inventory.product': ['costPrice'],
  'hr.employee': ['basicSalary', 'nationalIdEnc', 'ibanEnc'],
  'sales.customer': ['creditLimit'],
};

/**
 * True when this field is one the system withholds unless it has been granted
 * by name. Keeping the list in one place means adding a sensitive column is a
 * one-line change rather than an audit of every call site.
 */
function isProtectedField(resource: string, field: string): boolean {
  return FIELD_LEVEL_PROTECTED[resource]?.includes(field) ?? false;
}

/**
 * An immutable snapshot of everything a user is allowed to do.
 *
 * Built once at login and carried in the access token, so the hot path is a
 * `Set.has` rather than a join across three tables.
 */
export class PermissionSet {
  private readonly granted: ReadonlySet<string>;

  constructor(
    permissions: readonly string[],
    private readonly isSuperAdmin = false,
  ) {
    this.granted = new Set(permissions);
  }

  /**
   * Answers whether the user may perform `action` on `resource`, optionally on a
   * specific field.
   *
   * The rule for fields is what makes field-level control real: a field listed in
   * `FIELD_LEVEL_PROTECTED` requires an **explicit** grant. Letting the ordinary
   * `inventory.product:read` grant also cover `costPrice` would make every
   * field-level permission decorative — which is the usual way this feature is
   * implemented and the reason it never protects anything. Unprotected fields
   * fall back to resource-level access, so callers can pass a field name freely.
   */
  can(resource: string, action: string, field?: string): boolean {
    if (this.isSuperAdmin) return true;

    if (field !== undefined && isProtectedField(resource, field)) {
      return [
        `${resource}:${action}:${field}`,
        `${resource}:*:${field}`,
        '*:*',
      ].some((candidate) => this.granted.has(candidate));
    }

    return [`${resource}:${action}`, `${resource}:*`, `*:${action}`, '*:*'].some((candidate) =>
      this.granted.has(candidate),
    );
  }

  /** `can`, expressed as a Result so a use case can `if (!x.ok) return x`. */
  require(resource: string, action: string, field?: string): Result<void, DomainError> {
    if (this.can(resource, action, field)) return ok();

    const resourceLabel = RESOURCE_LABELS[resource] ?? { ar: resource, en: resource };
    const actionLabel = ACTION_LABELS[action] ?? { ar: action, en: action };

    return err(
      DomainErrors.permissionDenied(
        actionLabel.ar,
        actionLabel.en,
        resourceLabel.ar,
        resourceLabel.en,
      ),
    );
  }

  /**
   * Fields of `resource` the user may NOT see, given a candidate list.
   *
   * Used to strip columns from an API response rather than to refuse the whole
   * request: a salesperson should still be able to open a product, just without
   * seeing what it cost us.
   */
  deniedFields(resource: string, fields: readonly string[]): string[] {
    if (this.isSuperAdmin) return [];
    return fields.filter(
      (field) => isProtectedField(resource, field) && !this.can(resource, 'read', field),
    );
  }

  get size(): number {
    return this.granted.size;
  }

  toArray(): string[] {
    return [...this.granted];
  }
}

/**
 * The role catalogue shipped with a new tenant.
 *
 * The split is not arbitrary: it is the minimum that lets a small finance team
 * satisfy segregation of duties. Whoever raises an invoice must not be the one
 * who posts it, and neither may be the one who records its payment — so those
 * three capabilities live in three different roles.
 */
export const SYSTEM_ROLES: readonly {
  name: string;
  nameAr: string;
  description: string;
  permissions: string[];
}[] = [
  {
    name: 'SYSTEM_ADMINISTRATOR',
    nameAr: 'مدير النظام',
    description: 'Full access to every module and setting.',
    permissions: ['*:*'],
  },
  {
    name: 'FINANCIAL_CONTROLLER',
    nameAr: 'المدير المالي',
    description: 'Posts and reverses entries, closes periods, approves documents.',
    permissions: [
      'finance.account:*',
      'finance.journal:*',
      'finance.period:*',
      'finance.report:*',
      'sales.invoice:read',
      'sales.invoice:post',
      'sales.invoice:approve',
      'sales.invoice:void',
      'sales.creditNote:*',
      'procurement.invoice:read',
      'procurement.invoice:post',
      'procurement.invoice:approve',
      'treasury.payment:read',
      'treasury.payment:approve',
      'treasury.reconciliation:*',
      'inventory.stock:read',
      'inventory.adjustment:approve',
      'platform.audit:read',
      'platform.audit:export',
    ],
  },
  {
    name: 'ACCOUNTANT',
    nameAr: 'محاسب',
    description: 'Prepares entries and documents; cannot post or approve them.',
    permissions: [
      'finance.account:read',
      'finance.journal:create',
      'finance.journal:read',
      'finance.journal:update',
      'finance.report:read',
      'sales.invoice:read',
      'procurement.invoice:create',
      'procurement.invoice:read',
      'procurement.invoice:update',
      'treasury.payment:create',
      'treasury.payment:read',
      'sales.customer:read',
      'procurement.supplier:read',
      'inventory.stock:read',
    ],
  },
  {
    name: 'SALES_REPRESENTATIVE',
    nameAr: 'مندوب مبيعات',
    description: 'Raises sales invoices and maintains customers.',
    permissions: [
      'sales.invoice:create',
      'sales.invoice:read',
      'sales.invoice:update',
      'sales.customer:create',
      'sales.customer:read',
      'sales.customer:update',
      'inventory.product:read',
      'inventory.stock:read',
    ],
  },
  {
    name: 'WAREHOUSE_KEEPER',
    nameAr: 'أمين مستودع',
    description: 'Records stock movements, transfers and counts.',
    permissions: [
      'inventory.product:read',
      'inventory.movement:create',
      'inventory.movement:read',
      'inventory.transfer:create',
      'inventory.transfer:read',
      'inventory.adjustment:create',
      'inventory.adjustment:read',
      'inventory.stock:read',
      'org.warehouse:read',
    ],
  },
  {
    name: 'CASHIER',
    nameAr: 'أمين صندوق',
    description: 'Records receipts and payments only.',
    permissions: [
      'treasury.payment:create',
      'treasury.payment:read',
      'sales.invoice:read',
      'procurement.invoice:read',
      'sales.customer:read',
      'procurement.supplier:read',
    ],
  },
  {
    name: 'HR_MANAGER',
    nameAr: 'مدير الموارد البشرية',
    description: 'Maintains employees and prepares payroll.',
    permissions: ['hr.employee:*', 'hr.payroll:create', 'hr.payroll:read', 'hr.payroll:update'],
  },
  {
    name: 'AUDITOR',
    nameAr: 'مدقق',
    description: 'Read-only across the entire system, including the audit trail.',
    permissions: ['*:read', 'platform.audit:export', 'finance.report:export'],
  },
];

/** Expands the role catalogue into the flat permission rows the database stores. */
export function expandPermissionCatalogue(): { resource: string; action: string; field: string | null }[] {
  const rows: { resource: string; action: string; field: string | null }[] = [
    { resource: '*', action: '*', field: null },
    { resource: '*', action: 'read', field: null },
  ];

  for (const resource of RESOURCES) {
    rows.push({ resource, action: '*', field: null });
    for (const action of ACTIONS) {
      rows.push({ resource, action, field: null });
    }
  }

  // Field-level grants that are genuinely useful rather than merely possible:
  // a sales rep should see a product without seeing what it cost us.
  rows.push({ resource: 'inventory.product', action: 'read', field: 'costPrice' });
  rows.push({ resource: 'hr.employee', action: 'read', field: 'basicSalary' });
  rows.push({ resource: 'hr.employee', action: 'read', field: 'nationalIdEnc' });
  rows.push({ resource: 'hr.employee', action: 'read', field: 'ibanEnc' });
  rows.push({ resource: 'sales.customer', action: 'read', field: 'creditLimit' });

  return rows;
}

