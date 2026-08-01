import {
  Activity,
  ArrowLeftRight,
  Banknote,
  BookPlus,
  Boxes,
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Coins,
  FileSpreadsheet,
  FileText,
  FilePlus2,
  Fingerprint,
  Folders,
  Hammer,
  HandCoins,
  Landmark,
  LayoutDashboard,
  ListTree,
  Package,
  PackageSearch,
  Percent,
  QrCode,
  Receipt,
  Scale,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  Split,
  Truck,
  Undo2,
  UserCog,
  Users,
  Warehouse,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * The navigation tree.
 *
 * In its own module, away from the component that renders it, for one reason that matters more
 * than tidiness: a test can import it. `tests/unit/navigation.test.ts` asserts that every
 * `href` in this tree corresponds to a real `page.tsx` on disk, so a link to a screen that
 * does not exist fails the build rather than greeting a user with a 404.
 *
 * That guard exists because it was needed. Eight entries here pointed at pages that had never
 * been written — the two the user hit first were the journal register and the voucher
 * register, both of which had a working API and no screen.
 *
 * ## Structure, and why it is shaped this way
 *
 * Each module divides into **التهيئة / العمليات / التقارير** (setup / operations / reports),
 * which is the division every large ERP settles on because it maps to *who* uses a screen and
 * *how often*: setup is configured once by an administrator, operations are a clerk's daily
 * work, reports are what a manager reads. Sorting alphabetically or by module alone puts the
 * chart of accounts next to the journal register, and those two have nothing to do with each
 * other in anybody's day.
 *
 * ## An item with no `href` is not a broken link
 *
 * `href` is optional, and its absence is the whole design. Unbuilt screens are listed —
 * because the shape of the system is useful information, and hiding it makes the product look
 * smaller than its domain layer is — but they render as disabled text with a "قريباً" badge and
 * **no anchor element at all**. Not a disabled `<a href>`, which is still navigable by
 * middle-click, keyboard, or a screen reader that ignores `aria-disabled`. If there is no
 * page, there is no href.
 */

/** `setup` is configured once, `operations` is daily work, `reports` is what gets read. */
export type NavGroupKind = 'setup' | 'operations' | 'reports';

export interface NavItem {
  readonly labelAr: string;
  readonly labelEn: string;
  readonly icon: LucideIcon;
  /**
   * Present only when the page exists. Absent means "planned", and the renderer must not
   * produce a link — see the note above about why a disabled anchor is not good enough.
   */
  readonly href?: string;
}

export interface NavGroup {
  readonly kind: NavGroupKind;
  readonly items: readonly NavItem[];
}

export interface NavModule {
  readonly titleAr: string;
  readonly titleEn: string;
  readonly icon: LucideIcon;
  readonly groups: readonly NavGroup[];
}

export const GROUP_LABELS: Record<NavGroupKind, { ar: string; en: string }> = {
  setup: { ar: 'التهيئة', en: 'Setup' },
  operations: { ar: 'العمليات', en: 'Operations' },
  reports: { ar: 'التقارير', en: 'Reports' },
};

export const NAVIGATION: readonly NavModule[] = [
  {
    titleAr: 'لوحة المعلومات',
    titleEn: 'Dashboard',
    icon: LayoutDashboard,
    groups: [
      {
        kind: 'operations',
        items: [
          { href: '/', labelAr: 'لوحة المعلومات', labelEn: 'Dashboard', icon: LayoutDashboard },
          {
            href: '/approvals',
            labelAr: 'صندوق الاعتمادات',
            labelEn: 'Approval Inbox',
            icon: ClipboardCheck,
          },
        ],
      },
    ],
  },

  {
    titleAr: 'المالية',
    titleEn: 'Financials',
    icon: Scale,
    groups: [
      {
        kind: 'setup',
        items: [
          {
            href: '/finance/accounts',
            labelAr: 'شجرة الحسابات',
            labelEn: 'Chart of Accounts',
            icon: ListTree,
          },
          {
            href: '/finance/fiscal-years',
            labelAr: 'السنوات والفترات المالية',
            labelEn: 'Fiscal Calendar',
            icon: CalendarClock,
          },
          {
            href: '/finance/cost-centers',
            labelAr: 'مراكز التكلفة',
            labelEn: 'Cost Centres',
            icon: Split,
          },
          {
            href: '/finance/currencies',
            labelAr: 'العملات وأسعار الصرف',
            labelEn: 'Currencies & FX Rates',
            icon: Coins,
          },
          {
            href: '/finance/posting-rules',
            labelAr: 'قواعد الترحيل الآلي',
            labelEn: 'Posting Rules',
            icon: Folders,
          },
        ],
      },
      {
        kind: 'operations',
        items: [
          {
            href: '/finance/journals',
            labelAr: 'القيود المحاسبية',
            labelEn: 'Journal Entries',
            icon: FileText,
          },
          {
            href: '/finance/journals/new',
            labelAr: 'قيد جديد',
            labelEn: 'New Journal Entry',
            icon: BookPlus,
          },
          {
            href: '/treasury/payments',
            labelAr: 'سندات القبض والصرف',
            labelEn: 'Payment Vouchers',
            icon: Banknote,
          },
          {
            href: '/treasury/payments/new',
            labelAr: 'سند جديد',
            labelEn: 'New Voucher',
            icon: Wallet,
          },
          {
            href: '/treasury/reconciliation',
            labelAr: 'التسوية البنكية',
            labelEn: 'Bank Reconciliation',
            icon: Landmark,
          },
          {
            href: '/finance/depreciation',
            labelAr: 'إهلاك الأصول الثابتة',
            labelEn: 'Fixed Asset Depreciation',
            icon: Building2,
          },
          {
            href: '/finance/period-close',
            labelAr: 'إقفال الفترة',
            labelEn: 'Period Close',
            icon: CalendarClock,
          },
        ],
      },
      {
        kind: 'reports',
        items: [
          {
            href: '/finance/trial-balance',
            labelAr: 'ميزان المراجعة',
            labelEn: 'Trial Balance',
            icon: Scale,
          },
          {
            href: '/finance/balance-sheet',
            labelAr: 'قائمة المركز المالي',
            labelEn: 'Balance Sheet',
            icon: FileSpreadsheet,
          },
          {
            href: '/finance/income-statement',
            labelAr: 'قائمة الدخل',
            labelEn: 'Income Statement',
            icon: FileSpreadsheet,
          },
          {
            href: '/finance/general-ledger',
            labelAr: 'دفتر الأستاذ العام',
            labelEn: 'General Ledger',
            icon: ScrollText,
          },
          { href: '/finance/ageing', labelAr: 'أعمار الذمم', labelEn: 'Ageing Analysis', icon: Activity },
          {
            href: '/finance/collections',
            labelAr: 'لوحة التحصيل',
            labelEn: 'Collections',
            icon: HandCoins,
          },
        ],
      },
    ],
  },

  {
    titleAr: 'المخزون واللوجستيات',
    titleEn: 'Inventory & Logistics',
    icon: Boxes,
    groups: [
      {
        kind: 'setup',
        items: [
          { href: '/inventory/products', labelAr: 'الأصناف', labelEn: 'Products', icon: Package },
          {
            href: '/inventory/categories',
            labelAr: 'التصنيفات',
            labelEn: 'Categories',
            icon: Folders,
          },
          { href: '/inventory/brands', labelAr: 'الماركات', labelEn: 'Brands', icon: Package },
          { href: '/inventory/units', labelAr: 'وحدات القياس', labelEn: 'Units of Measure', icon: Boxes },
          { href: '/org/branches', labelAr: 'المستودعات', labelEn: 'Warehouses', icon: Warehouse },
        ],
      },
      {
        kind: 'operations',
        items: [
          {
            href: '/inventory/stock-card',
            labelAr: 'بطاقة الصنف',
            labelEn: 'Stock Card',
            icon: ScrollText,
          },
          {
            href: '/inventory/transfers',
            labelAr: 'التحويلات المخزنية',
            labelEn: 'Stock Transfers',
            icon: ArrowLeftRight,
          },
          {
            href: '/inventory/adjustments',
            labelAr: 'تسويات المخزون',
            labelEn: 'Stock Adjustments',
            icon: PackageSearch,
          },
          {
            href: '/inventory/counts',
            labelAr: 'الجرد الفعلي',
            labelEn: 'Physical Count',
            icon: ClipboardCheck,
          },
          {
            href: '/inventory/assemblies',
            labelAr: 'أوامر التجميع',
            labelEn: 'Assembly Orders',
            icon: Hammer,
          },
        ],
      },
      {
        kind: 'reports',
        items: [
          { href: '/inventory/stock', labelAr: 'أرصدة المخزون', labelEn: 'Stock Balances', icon: Warehouse },
          {
            href: '/inventory/valuation',
            labelAr: 'تقييم المخزون',
            labelEn: 'Inventory Valuation',
            icon: Coins,
          },
          {
            href: '/inventory/movement-analysis',
            labelAr: 'حركة الأصناف',
            labelEn: 'Movement Analysis',
            icon: Activity,
          },
          {
            href: '/inventory/slow-moving',
            labelAr: 'الأصناف الراكدة',
            labelEn: 'Slow-Moving Stock',
            icon: PackageSearch,
          },
        ],
      },
    ],
  },

  {
    titleAr: 'المبيعات والمشتريات',
    titleEn: 'Sales & Procurement',
    icon: ShoppingCart,
    groups: [
      {
        kind: 'setup',
        items: [
          { href: '/sales/customers', labelAr: 'العملاء', labelEn: 'Customers', icon: Users },
          { href: '/procurement/suppliers', labelAr: 'الموردون', labelEn: 'Suppliers', icon: Truck },
          {
            href: '/sales/price-lists',
            labelAr: 'قوائم الأسعار',
            labelEn: 'Price Lists',
            icon: FileSpreadsheet,
          },
          {
            href: '/sales/payment-terms',
            labelAr: 'شروط الدفع',
            labelEn: 'Payment Terms',
            icon: CalendarClock,
          },
        ],
      },
      {
        kind: 'operations',
        items: [
          {
            href: '/sales/invoices',
            labelAr: 'فواتير المبيعات',
            labelEn: 'Sales Invoices',
            icon: Receipt,
          },
          {
            href: '/sales/invoices/new',
            labelAr: 'فاتورة مبيعات جديدة',
            labelEn: 'New Sales Invoice',
            icon: FilePlus2,
          },
          {
            href: '/sales/quotations',
            labelAr: 'عروض الأسعار',
            labelEn: 'Quotations',
            icon: FileText,
          },
          {
            href: '/sales/orders',
            labelAr: 'أوامر البيع',
            labelEn: 'Sales Orders',
            icon: ShoppingCart,
          },
          {
            href: '/sales/returns',
            labelAr: 'مرتجعات المبيعات',
            labelEn: 'Sales Returns',
            icon: Undo2,
          },
          {
            href: '/procurement/invoices',
            labelAr: 'فواتير المشتريات',
            labelEn: 'Purchase Invoices',
            icon: FileText,
          },
          {
            href: '/procurement/orders',
            labelAr: 'أوامر الشراء',
            labelEn: 'Purchase Orders',
            icon: ClipboardList,
          },
        ],
      },
      {
        kind: 'reports',
        items: [
          {
            href: '/sales/analysis-by-customer',
            labelAr: 'المبيعات حسب العميل',
            labelEn: 'Sales by Customer',
            icon: Users,
          },
          {
            href: '/sales/analysis-by-product',
            labelAr: 'المبيعات حسب الصنف',
            labelEn: 'Sales by Product',
            icon: Package,
          },
          {
            href: '/sales/margins',
            labelAr: 'هوامش الربح',
            labelEn: 'Profit Margins',
            icon: Percent,
          },
          {
            href: '/procurement/analysis-by-supplier',
            labelAr: 'المشتريات حسب المورد',
            labelEn: 'Purchases by Supplier',
            icon: Truck,
          },
        ],
      },
    ],
  },

  {
    titleAr: 'إدارة النظام والأمان',
    titleEn: 'System & GRC',
    icon: ShieldCheck,
    groups: [
      {
        kind: 'setup',
        items: [
          { href: '/system/users', labelAr: 'المستخدمون', labelEn: 'Users', icon: UserCog },
          {
            href: '/system/roles',
            labelAr: 'الأدوار والصلاحيات',
            labelEn: 'Roles & Permissions',
            icon: ShieldCheck,
          },
          {
            href: '/org/branches',
            labelAr: 'الفروع والمستودعات',
            labelEn: 'Branches & Warehouses',
            icon: Building2,
          },
          {
            href: '/system/approval-rules',
            labelAr: 'قواعد الموافقات',
            labelEn: 'Approval Rules',
            icon: ClipboardCheck,
          },
          {
            href: '/system/zatca',
            labelAr: 'الفوترة الإلكترونية (ZATCA)',
            labelEn: 'ZATCA E-Invoicing',
            icon: QrCode,
          },
          {
            href: '/system/tax-codes',
            labelAr: 'إعدادات الضرائب',
            labelEn: 'Tax Settings',
            icon: Percent,
          },
          {
            href: '/system/number-sequences',
            labelAr: 'تسلسل الترقيم',
            labelEn: 'Number Sequences',
            icon: ListTree,
          },
        ],
      },
      {
        kind: 'operations',
        items: [
          {
            href: '/approvals',
            labelAr: 'صندوق الاعتمادات',
            labelEn: 'Approval Inbox',
            icon: ClipboardCheck,
          },
          { labelAr: 'الإقرارات الضريبية', labelEn: 'VAT Returns', icon: Percent },
          { labelAr: 'فصل المهام المتعارضة', labelEn: 'Segregation of Duties', icon: Split },
        ],
      },
      {
        kind: 'reports',
        items: [
          { href: '/system/audit', labelAr: 'سجل التدقيق', labelEn: 'Audit Trail', icon: Fingerprint },
          { labelAr: 'سجل دخول المستخدمين', labelEn: 'Sign-in History', icon: Activity },
          { labelAr: 'تقرير الضريبة', labelEn: 'VAT Report', icon: FileSpreadsheet },
        ],
      },
    ],
  },
];

/** Every routable destination in the tree. The 404 test walks exactly this. */
export function navigableHrefs(): string[] {
  return NAVIGATION.flatMap((module) =>
    module.groups.flatMap((group) =>
      group.items.map((item) => item.href).filter((href): href is string => href !== undefined),
    ),
  );
}

/**
 * The module whose section should be open for a given path.
 *
 * Longest match wins, so `/finance/journals/new` opens Financials on the strength of
 * `/finance/journals/new` rather than being claimed by a shorter prefix elsewhere.
 */
export function activeModuleFor(pathname: string): string | null {
  let best: { title: string; length: number } | null = null;

  for (const module of NAVIGATION) {
    for (const group of module.groups) {
      for (const item of group.items) {
        if (item.href === undefined) continue;
        const matches = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        if (!matches) continue;
        if (best === null || item.href.length > best.length) {
          best = { title: module.titleEn, length: item.href.length };
        }
      }
    }
  }

  return best?.title ?? null;
}
