import Link from 'next/link';
import { BookPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney, statusLabel } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'القيود المحاسبية' };

const PAGE_SIZE = 25;

/**
 * The general ledger register.
 *
 * The counterpart to the entry form, which existed without it — so the sidebar linked here
 * and returned a 404. Server-paginated for the same reason the invoice register is: a demo
 * holds five hundred entries and a real ledger holds two hundred thousand a year, and
 * rendering all of them to let the browser paginate works right up until it does not.
 *
 * `type` is shown as prominently as the amount because it is what tells an accountant
 * whether an entry was posted *by* something — a sale, a payment, a depreciation run — or
 * written by hand. Almost everything here should be automatic; a ledger with many GENERAL
 * entries is a ledger where the posting rules are being worked around.
 */

const TYPE_LABELS: Record<string, string> = {
  GENERAL: 'عام',
  SALES: 'مبيعات',
  PURCHASE: 'مشتريات',
  CASH: 'نقدية',
  INVENTORY: 'مخزون',
  PAYROLL: 'رواتب',
  ADJUSTMENT: 'تسوية',
  DEPRECIATION: 'إهلاك',
  OPENING: 'افتتاحي',
  CLOSING: 'إقفال',
};

const STATUS_FILTERS = [
  { value: 'ALL', label: 'الكل' },
  { value: 'DRAFT', label: 'مسودة' },
  { value: 'POSTED', label: 'مرحّل' },
  { value: 'REVERSED', label: 'معكوس' },
];

export default async function JournalsPage({
  searchParams,
}: {
  searchParams: { page?: string; status?: string; type?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const status = searchParams.status;
  const type = searchParams.type;

  const { journals, total, functionalCurrency, canCreate } = await withPageScope(
    async (context) => {
      const where = {
        tenantId: context.tenantId,
        ...(status !== undefined && status !== 'ALL' ? { status: status as never } : {}),
        ...(type !== undefined && type !== 'ALL' ? { type: type as never } : {}),
      };

      const [loadedJournals, loadedTotal, tenant] = await Promise.all([
        prisma.journal.findMany({
          where,
          select: {
            id: true,
            entryNumber: true,
            type: true,
            status: true,
            date: true,
            descriptionAr: true,
            currency: true,
            totalDebit: true,
            totalCredit: true,
            referenceType: true,
            _count: { select: { lines: true } },
          },
          orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        prisma.journal.count({ where }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: context.tenantId },
          select: { functionalCurrency: true },
        }),
      ]);

      return {
        journals: loadedJournals,
        total: loadedTotal,
        functionalCurrency: tenant.functionalCurrency,
        canCreate: context.permissions.can('finance.journal', 'create'),
      };
    },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { status, type, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/finance/journals?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">القيود المحاسبية</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="numeric">{total.toLocaleString('en-US')}</span> قيد في دفتر الأستاذ
          </p>
        </div>
        {canCreate ? (
          <Link href="/finance/journals/new">
            <Button>
              <BookPlus className="h-4 w-4" aria-hidden="true" />
              قيد جديد
            </Button>
          </Link>
        ) : null}
      </header>

      <Card>
        <CardHeader
          title="السجل"
          description="القيد المُرحَّل تاريخ لا يُعدَّل — يُعكَس بقيد مقابل"
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

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم القيد</th>
                <th scope="col">التاريخ</th>
                <th scope="col">النوع</th>
                <th scope="col">البيان</th>
                <th scope="col" className="numeric">
                  السطور
                </th>
                <th scope="col" className="numeric">
                  مدين
                </th>
                <th scope="col" className="numeric">
                  دائن
                </th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {journals.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-muted-foreground">
                    لا توجد قيود مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                journals.map((journal) => {
                  const badge = statusLabel(journal.status);
                  // Every posted entry balances — the trigger refuses one that does not — so a
                  // mismatch here can only be a DRAFT still being worked on. Showing it is
                  // what makes the draft's state visible before someone tries to post it.
                  const balanced = journal.totalDebit.equals(journal.totalCredit);

                  return (
                    <tr key={journal.id}>
                      <td>
                        <span className="bidi-isolate font-mono text-xs font-medium text-primary">
                          {journal.entryNumber}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(journal.date, { calendar: 'gregorian', style: 'medium' })}
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {TYPE_LABELS[journal.type] ?? journal.type}
                      </td>
                      <td className="max-w-[20rem]">
                        <p className="truncate">{journal.descriptionAr}</p>
                        {journal.referenceType !== null ? (
                          <p className="bidi-isolate text-[11px] text-muted-foreground">
                            {journal.referenceType}
                          </p>
                        ) : null}
                      </td>
                      <td className="numeric text-muted-foreground">{journal._count.lines}</td>
                      <td className="numeric font-medium">
                        {formatMoney(journal.totalDebit.toFixed(4), {
                          currency: journal.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric font-medium">
                        <span className={balanced ? undefined : 'text-destructive'}>
                          {formatMoney(journal.totalCredit.toFixed(4), {
                            currency: journal.currency,
                            showCurrency: false,
                          })}
                        </span>
                      </td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {!balanced ? (
                          <Badge tone="danger" className="ms-1">
                            غير متوازن
                          </Badge>
                        ) : null}
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
                href={queryFor({ page: String(Math.max(1, page - 1)) })}
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
                href={queryFor({ page: String(Math.min(totalPages, page + 1)) })}
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
        العملة الوظيفية للمنشأة: <span className="bidi-isolate">{functionalCurrency}</span>
      </p>
    </div>
  );
}
