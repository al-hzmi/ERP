import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { listStockCounts } from '@/lib/application/services/stock-count-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الجرد الفعلي' };

const PAGE_SIZE = 25;

const STATUS_LABELS: Record<string, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  COUNTING: { label: 'جارٍ العدّ', tone: 'info' },
  COMPLETED: { label: 'مُعتمد', tone: 'success' },
  CANCELLED: { label: 'ملغى', tone: 'neutral' },
};

/**
 * The stock count register, and the form that opens a new sheet.
 *
 * Opening a sheet freezes the whole warehouse's position at that instant, which is why the
 * form says so rather than presenting it as an ordinary "create" button: the user is choosing
 * a moment, not just a warehouse, and everything the count later claims is measured against it.
 */
export default async function StockCountsPage({
  searchParams,
}: {
  searchParams: { page?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);

  const { rows, total, warehouses, canCreate, today } = await withPageScope(async (context) => {
    const [listed, loadedWarehouses] = await Promise.all([
      listStockCounts({ tenantId: context.tenantId, page, pageSize: PAGE_SIZE }),
      prisma.warehouse.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
    ]);

    return {
      ...listed,
      warehouses: loadedWarehouses,
      canCreate: context.permissions.can('inventory.adjustment', 'create'),
      today: new Date().toISOString().slice(0, 10),
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الجرد الفعلي</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> ورقة جرد — الأرصدة
          تُجمَّد لحظة الفتح
        </p>
      </header>

      {canCreate ? (
        <Card>
          <CardHeader
            title="فتح ورقة جرد"
            description="يُلتقط رصيد كل صنف في المستودع لحظة الفتح ويُجمَّد — الفروقات تُقاس عليه لا على رصيد متحرك"
          />
          <CardBody>
            {/* A plain form posting to the API route: opening a sheet is one decision with no
                intermediate state, so a client component would add a bundle for nothing. */}
            <form
              method="post"
              action="/api/inventory/counts"
              className="flex flex-wrap items-end gap-3"
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">المستودع</span>
                <select
                  name="warehouseId"
                  required
                  className="h-9 min-w-[16rem] rounded-md border border-input bg-background px-3 text-sm"
                >
                  {warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} · {warehouse.nameAr}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">تاريخ الجرد</span>
                <input
                  type="date"
                  name="countDate"
                  defaultValue={today}
                  required
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs">
                <span className="text-muted-foreground">ملاحظات</span>
                <input
                  type="text"
                  name="notes"
                  placeholder="اختياري"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <button
                type="submit"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                فتح الورقة
              </button>
            </form>
            <p className="mt-2 text-[11px] text-muted-foreground">
              يُسمح بورقة مفتوحة واحدة لكل مستودع — ورقتان تعنيان قياس نفس الرفّ على وضعين
              مختلفين وترحيل الفرق مرتين.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="السجل" description="الأحدث أولاً" />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الجرد</th>
                <th scope="col">التاريخ</th>
                <th scope="col">المستودع</th>
                <th scope="col" className="numeric">التقدّم</th>
                <th scope="col">الحالة</th>
                <th scope="col">الاعتماد</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    <ClipboardCheck className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                    لا توجد عمليات جرد بعد
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const status = STATUS_LABELS[row.status] ?? {
                    label: row.status,
                    tone: 'neutral' as const,
                  };

                  return (
                    <tr key={row.id}>
                      <td>
                        <Link
                          href={`/inventory/counts/${row.id}`}
                          className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                        >
                          {row.countNumber}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(row.countDate, { calendar: 'gregorian', style: 'medium' })}
                      </td>
                      <td className="text-xs">
                        <span className="bidi-isolate font-mono">{row.warehouseCode}</span>
                        <span className="ms-2 text-muted-foreground">{row.warehouseNameAr}</span>
                      </td>
                      <td className="numeric text-xs">
                        {row.countedLines} / {row.totalLines}
                      </td>
                      <td>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="whitespace-nowrap text-xs text-muted-foreground">
                        {row.finalisedAt === null
                          ? '—'
                          : formatDate(row.finalisedAt, { style: 'medium' })}
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
                href={`/inventory/counts?page=${Math.max(1, page - 1)}`}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </Link>
              <Link
                href={`/inventory/counts?page=${Math.min(totalPages, page + 1)}`}
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
    </div>
  );
}
