import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney, statusLabel } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'فواتير المبيعات' };

const PAGE_SIZE = 25;

/**
 * The sales invoice register.
 *
 * Pagination is server-side and the page size is capped. Rendering every invoice
 * and letting the browser paginate works beautifully with the two hundred rows a
 * demo contains and falls over completely at the two hundred thousand a real
 * ledger accumulates in a year.
 */
export default async function SalesInvoicesPage({
  searchParams,
}: {
  searchParams: { page?: string; status?: string; q?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const status = searchParams.status;
  const query = searchParams.q?.trim();

  const { invoices, total, tenant, canCreate } = await withPageScope(async (context) => {
    const where = {
      tenantId: context.tenantId,
      type: 'SALES_INVOICE' as const,
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

    const [loadedInvoices, loadedTotal, loadedTenant] = await Promise.all([
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
          counterparty: { select: { code: true, nameAr: true } },
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

    return {
      invoices: loadedInvoices,
      total: loadedTotal,
      tenant: loadedTenant,
      canCreate: context.permissions.can('sales.invoice', 'create'),
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const STATUS_FILTERS = [
    { value: 'ALL', label: 'الكل' },
    { value: 'DRAFT', label: 'مسودة' },
    { value: 'POSTED', label: 'مرحّل' },
    { value: 'PARTIAL_PAID', label: 'مسدد جزئياً' },
    { value: 'FULLY_PAID', label: 'مسدد بالكامل' },
    { value: 'VOID', label: 'ملغى' },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">فواتير المبيعات</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="numeric">{total.toLocaleString('en-US')}</span> فاتورة
          </p>
        </div>
        {canCreate ? (
          <Link href="/sales/invoices/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              فاتورة جديدة
            </Button>
          </Link>
        ) : null}
      </header>

      <Card>
        <CardHeader
          title="السجل"
          description="مُرشَّح حسب الحالة. شاشة تفاصيل الفاتورة لم تُنفَّذ بعد"
          action={
            <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب الحالة">
              {STATUS_FILTERS.map((filter) => {
                const active = (status ?? 'ALL') === filter.value;
                return (
                  <Link
                    key={filter.value}
                    href={`/sales/invoices?status=${filter.value}`}
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

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الفاتورة</th>
                <th scope="col">العميل</th>
                <th scope="col">الفرع</th>
                <th scope="col">تاريخ الإصدار</th>
                <th scope="col">تاريخ الاستحقاق</th>
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
                  const overdue =
                    outstanding.greaterThan(0) && invoice.dueDate < new Date();

                  return (
                    <tr key={invoice.id}>
                      <td>
                        {/* Not a link. The invoice detail page has not been built, and an
                            anchor to it answered 404 — the same defect the sidebar had. It
                            becomes a link the moment the page exists. */}
                        <span className="bidi-isolate font-mono text-xs font-medium text-primary">
                          {invoice.documentNumber}
                        </span>
                      </td>
                      <td className="max-w-[16rem]">
                        <p className="truncate">{invoice.counterparty.nameAr}</p>
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
                        <span className={outstanding.greaterThan(0) ? 'font-medium' : 'text-muted-foreground'}>
                          {formatMoney(outstanding.toFixed(4), {
                            currency: invoice.currency,
                            showCurrency: false,
                          })}
                        </span>
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
              صفحة <span className="numeric">{page}</span> من{' '}
              <span className="numeric">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Link
                href={`/sales/invoices?page=${Math.max(1, page - 1)}${status !== undefined ? `&status=${status}` : ''}`}
                aria-disabled={page === 1}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </Link>
              <Link
                href={`/sales/invoices?page=${Math.min(totalPages, page + 1)}${status !== undefined ? `&status=${status}` : ''}`}
                aria-disabled={page === totalPages}
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
        العملة الوظيفية للمنشأة: <span className="bidi-isolate">{tenant.functionalCurrency}</span>
      </p>
    </div>
  );
}
