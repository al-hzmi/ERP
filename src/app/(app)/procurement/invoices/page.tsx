import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney, statusLabel } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'فواتير المشتريات' };

const PAGE_SIZE = 25;

const STATUS_FILTERS = [
  { value: 'ALL', label: 'الكل' },
  { value: 'DRAFT', label: 'مسودة' },
  { value: 'POSTED', label: 'مرحّلة' },
  { value: 'PARTIAL_PAID', label: 'مسددة جزئياً' },
  { value: 'FULLY_PAID', label: 'مسددة' },
  { value: 'VOID', label: 'ملغاة' },
];

/**
 * The purchase invoice register.
 *
 * `postPurchaseInvoice` has been receiving stock and posting to the ledger since the first
 * commit with nothing displaying its output — the same gap the journal and voucher registers
 * had. Entry is not built here: a purchase invoice carries line-level costing that feeds FIFO
 * layers, and a form that got it subtly wrong would corrupt inventory valuation rather than
 * merely annoy someone. The register is honest about that in its own subtitle.
 */
export default async function PurchaseInvoicesPage({
  searchParams,
}: {
  searchParams: { page?: string; status?: string; q?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const status = searchParams.status;
  const query = searchParams.q?.trim();

  const { invoices, total, currency } = await withPageScope(async (context) => {
    const where = {
      tenantId: context.tenantId,
      type: 'PURCHASE_INVOICE' as const,
      ...(status !== undefined && status !== 'ALL' ? { status: status as never } : {}),
      ...(query !== undefined && query !== ''
        ? {
            OR: [
              { documentNumber: { contains: query, mode: 'insensitive' as const } },
              { counterparty: { nameAr: { contains: query, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [loaded, loadedTotal, tenant] = await Promise.all([
      prisma.document.findMany({
        where,
        select: {
          id: true,
          documentNumber: true,
          status: true,
          issueDate: true,
          dueDate: true,
          currency: true,
          total: true,
          paidAmount: true,
          counterparty: { select: { id: true, code: true, nameAr: true } },
          branch: { select: { nameAr: true } },
        },
        orderBy: [{ issueDate: 'desc' }, { documentNumber: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.document.count({ where }),
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    return { invoices: loaded, total: loadedTotal, currency: tenant.functionalCurrency };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { q: query, status, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/procurement/invoices?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">فواتير المشتريات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> فاتورة — الإدخال يتم
          حالياً عبر الـ API، والشاشة للعرض والمتابعة
        </p>
      </header>

      <Card>
        <CardHeader
          title="السجل"
          description="المتبقي هو ما لم يُسدَّد بعد — يُسوّى بسند صرف من شاشة السندات"
          action={
            <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب الحالة">
              {STATUS_FILTERS.map((filter) => {
                const active = (status ?? 'ALL') === filter.value;
                return (
                  <Link
                    key={filter.value}
                    href={queryFor({ status: filter.value, page: '1' })}
                    className={
                      active
                        ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                        : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
                    }
                  >
                    {filter.label}
                  </Link>
                );
              })}
            </nav>
          }
        />

        <form method="get" action="/procurement/invoices" className="flex flex-wrap gap-2 px-5 pb-4">
          <input type="hidden" name="status" value={status ?? 'ALL'} />
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="ابحث برقم الفاتورة أو اسم المورد…"
            aria-label="بحث في فواتير المشتريات"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            بحث
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الفاتورة</th>
                <th scope="col">المورد</th>
                <th scope="col">الفرع</th>
                <th scope="col">الإصدار</th>
                <th scope="col">الاستحقاق</th>
                <th scope="col" className="numeric">الإجمالي</th>
                <th scope="col" className="numeric">المسدد</th>
                <th scope="col" className="numeric">المتبقي</th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-muted-foreground">
                    لا توجد فواتير مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => {
                  const badge = statusLabel(invoice.status);
                  const outstanding = invoice.total.minus(invoice.paidAmount);
                  const overdue = outstanding.greaterThan(0) && invoice.dueDate < new Date();

                  return (
                    <tr key={invoice.id}>
                      <td>
                        {/* Text, not a link: no purchase invoice detail screen exists. */}
                        <span className="bidi-isolate font-mono text-xs font-medium text-primary">
                          {invoice.documentNumber}
                        </span>
                      </td>
                      <td className="max-w-[16rem]">
                        <Link
                          href={`/procurement/suppliers/${invoice.counterparty.id}`}
                          className="block truncate hover:underline"
                        >
                          {invoice.counterparty.nameAr}
                        </Link>
                        <p className="bidi-isolate text-[11px] text-muted-foreground">
                          {invoice.counterparty.code}
                        </p>
                      </td>
                      <td className="text-muted-foreground">{invoice.branch.nameAr}</td>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(invoice.issueDate, { calendar: 'gregorian', style: 'medium' })}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        <span className={overdue ? 'font-medium text-destructive' : undefined}>
                          {formatDate(invoice.dueDate, { calendar: 'gregorian', style: 'medium' })}
                        </span>
                      </td>
                      <td className="numeric font-medium">
                        {formatMoney(invoice.total.toFixed(4), {
                          currency: invoice.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric text-muted-foreground">
                        {formatMoney(invoice.paidAmount.toFixed(4), {
                          currency: invoice.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric">
                        {formatMoney(outstanding.toFixed(4), {
                          currency: invoice.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
            <p className="text-muted-foreground">
              صفحة <span className="numeric">{page}</span> من <span className="numeric">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Link
                href={queryFor({ page: String(Math.max(1, page - 1)) })}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </Link>
              <Link
                href={queryFor({ page: String(Math.min(totalPages, page + 1)) })}
                className={
                  page === totalPages
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                التالي
              </Link>
            </div>
          </div>
        ) : null}
      </Card>

      <p className="text-xs text-muted-foreground">
        العملة الوظيفية للمنشأة: <span className="bidi-isolate">{currency}</span>
      </p>
    </div>
  );
}
