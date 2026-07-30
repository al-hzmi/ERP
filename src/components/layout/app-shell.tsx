'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftRight,
  Banknote,
  Building2,
  BookPlus,
  Landmark,
  Boxes,
  ClipboardCheck,
  FilePlus2,
  ChevronsLeftRight,
  FileText,
  LayoutDashboard,
  Moon,
  Receipt,
  Scale,
  ScrollText,
  Search,
  Sun,
  Users,
  Warehouse,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { OfflineBar } from './offline-bar';
import { cn } from '@/lib/utils/cn';
import { useUiStore } from '@/store/ui-store';
import { GlobalSearch } from './global-search';

/**
 * The application frame: a right-hand sidebar, a header, and the page.
 *
 * The sidebar sits on the right because the document direction is RTL — it is
 * positioned with logical properties (`start`/`end`) rather than left/right, so
 * switching the interface to English moves it without a single CSS override.
 */

interface NavItem {
  readonly href: string;
  readonly labelAr: string;
  readonly labelEn: string;
  readonly icon: typeof LayoutDashboard;
}

interface NavSection {
  readonly titleAr: string;
  readonly titleEn: string;
  readonly items: readonly NavItem[];
}

const NAVIGATION: readonly NavSection[] = [
  {
    titleAr: 'الرئيسية',
    titleEn: 'Overview',
    items: [
      { href: '/', labelAr: 'لوحة المعلومات', labelEn: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    titleAr: 'المبيعات',
    titleEn: 'Sales',
    items: [
      { href: '/sales/invoices', labelAr: 'فواتير المبيعات', labelEn: 'Sales Invoices', icon: Receipt },
      { href: '/sales/invoices/new', labelAr: 'فاتورة جديدة', labelEn: 'New Invoice', icon: FilePlus2 },
      { href: '/sales/customers', labelAr: 'العملاء', labelEn: 'Customers', icon: Users },
    ],
  },
  {
    titleAr: 'المشتريات',
    titleEn: 'Procurement',
    items: [
      { href: '/procurement/invoices', labelAr: 'فواتير المشتريات', labelEn: 'Purchase Invoices', icon: FileText },
      { href: '/procurement/suppliers', labelAr: 'الموردون', labelEn: 'Suppliers', icon: Users },
    ],
  },
  {
    titleAr: 'المخزون',
    titleEn: 'Inventory',
    items: [
      { href: '/inventory/products', labelAr: 'الأصناف', labelEn: 'Products', icon: Boxes },
      { href: '/inventory/stock-card', labelAr: 'بطاقة الصنف', labelEn: 'Stock Card', icon: ScrollText },
      { href: '/inventory/stock', labelAr: 'أرصدة المخزون', labelEn: 'Stock Balances', icon: Warehouse },
      { href: '/inventory/transfers', labelAr: 'التحويلات', labelEn: 'Transfers', icon: ArrowLeftRight },
    ],
  },
  {
    titleAr: 'المالية',
    titleEn: 'Financials',
    items: [
      { href: '/finance/journals', labelAr: 'القيود المحاسبية', labelEn: 'Journal Entries', icon: FileText },
      { href: '/finance/journals/new', labelAr: 'قيد جديد', labelEn: 'New Journal Entry', icon: BookPlus },
      { href: '/finance/trial-balance', labelAr: 'ميزان المراجعة', labelEn: 'Trial Balance', icon: Scale },
      { href: '/treasury/payments', labelAr: 'سندات القبض والصرف', labelEn: 'Payment Vouchers', icon: Banknote },
      { href: '/treasury/reconciliation', labelAr: 'التسوية البنكية', labelEn: 'Bank Reconciliation', icon: Landmark },
      { href: '/finance/depreciation', labelAr: 'إهلاك الأصول الثابتة', labelEn: 'Fixed Asset Depreciation', icon: Building2 },
    ],
  },
  {
    titleAr: 'الحاكمية',
    titleEn: 'Governance',
    items: [
      { href: '/approvals', labelAr: 'صندوق الاعتمادات', labelEn: 'Approvals', icon: ClipboardCheck },
    ],
  },
];

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: { fullNameAr: string; fullNameEn: string; tenantNameAr: string } | null;
}): JSX.Element {
  const pathname = usePathname();
  const { locale, theme, sidebarCollapsed, toggleTheme, toggleSidebar } = useUiStore();
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl/Cmd+K opens search from anywhere — the shortcut every user of a system
  // like this already has in their fingers.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          'no-print sticky top-0 flex h-screen shrink-0 flex-col border-e border-border bg-card',
          'transition-[width] duration-200 ease-out',
          sidebarCollapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-border px-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </div>
          {!sidebarCollapsed ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">
                {user?.tenantNameAr ?? 'نظام تخطيط الموارد'}
              </p>
              <p className="text-xs text-muted-foreground">ERP</p>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="التنقل الرئيسي">
          {NAVIGATION.map((section) => (
            <div key={section.titleEn}>
              {!sidebarCollapsed ? (
                <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {locale === 'ar' ? section.titleAr : section.titleEn}
                </p>
              ) : null}
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const active =
                    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                  const Icon = item.icon;
                  const label = locale === 'ar' ? item.labelAr : item.labelEn;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={sidebarCollapsed ? label : undefined}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors',
                          active
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                        {!sidebarCollapsed ? <span className="truncate">{label}</span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={toggleSidebar}
          className="flex items-center gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground hover:bg-accent"
          aria-label={sidebarCollapsed ? 'توسيع القائمة' : 'طي القائمة'}
        >
          <ChevronsLeftRight className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          {!sidebarCollapsed ? <span>طي القائمة</span> : null}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-border bg-background/85 px-6 backdrop-blur">
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true);
            }}
            className="flex h-9 min-w-0 flex-1 max-w-md items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">بحث في الأصناف والعملاء والفواتير…</span>
            <kbd className="ms-auto hidden shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] sm:inline">
              Ctrl K
            </kbd>
          </button>

          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              aria-label={theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}
            >
              {theme === 'dark' ? (
                <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>

            {user !== null ? (
              <div className="flex items-center gap-3 border-s border-border ps-3">
                <div className="hidden text-end sm:block">
                  <p className="text-sm font-medium leading-tight">{user.fullNameAr}</p>
                  <p className="text-xs text-muted-foreground">{user.fullNameEn}</p>
                </div>
                <div className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {user.fullNameAr.charAt(0)}
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {/* Above the content rather than pinned: a banner that overlays the page hides
            the field someone is typing into, and this one appears while they type. */}
        <OfflineBar />

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>

      <GlobalSearch
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
        }}
      />
    </div>
  );
}
