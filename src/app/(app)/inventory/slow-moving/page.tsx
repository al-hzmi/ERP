import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getSlowMovingStock } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الأصناف الراكدة' };

/**
 * Stock on hand that has not been issued for a while.
 *
 * Products that have *never* been issued are included and sorted with the rest — they are the
 * strongest finding on the report, and a naive `last_issue < cutoff` would drop every one of
 * them because NULL fails every comparison.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { to?: string; days?: string; warehouse?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const asOf = parseReportDate(searchParams.to, fallback.to);
  const parsedDays = Number(searchParams.days ?? '90');
  const thresholdDays = Number.isInteger(parsedDays) && parsedDays > 0 ? parsedDays : 90;

  const { rows, warehouses, currency } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      rows: await getSlowMovingStock({
        tenantId: context.tenantId,
        asOf: new Date(`${asOf}T00:00:00.000Z`),
        thresholdDays,
        currency: tenant.functionalCurrency,
        ...(searchParams.warehouse !== undefined && searchParams.warehouse !== ''
          ? { warehouseId: searchParams.warehouse }
          : {}),
      }),
      warehouses: await prisma.warehouse.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
      currency: tenant.functionalCurrency,
    };
  });

  const neverIssued = rows.filter((row) => row.lastIssueDate === null).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الأصناف الراكدة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          أصناف لها رصيد ولم تُصرف منذ {thresholdDays} يوماً على الأقل، كما في {asOf}
          {neverIssued > 0 ? ` — منها ${neverIssued} صنفاً لم يُصرف مطلقاً` : ''}
        </p>
      </header>

      <ReportFilters
        action="/inventory/slow-moving"
        toDate={asOf}
        showFrom={false}
        extra={
          <>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">حد الركود (يوم)</span>
              <input
                type="number"
                name="days"
                min="1"
                defaultValue={thresholdDays}
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">المستودع</span>
              <select
                name="warehouse"
                defaultValue={searchParams.warehouse ?? ''}
                className="h-9 min-w-[12rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">كل المستودعات</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} — {warehouse.nameAr}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />

      <Card>
        <CardHeader
          title="الأصناف الراكدة"
          description={`${rows.length} صنفاً، مرتَّبة بقيمة المخزون المحتجَز`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">التصنيف</th>
                <th scope="col" className="numeric">الرصيد</th>
                <th scope="col" className="numeric">القيمة</th>
                <th scope="col">آخر صرف</th>
                <th scope="col" className="numeric">أيام الركود</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    لا توجد أصناف راكدة بهذا الحد
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.productId}>
                    <td className="max-w-[18rem]">
                      <p className="bidi-isolate font-mono text-[11px] text-primary">{row.sku}</p>
                      <p className="truncate">{row.nameAr}</p>
                    </td>
                    <td className="text-xs text-muted-foreground">{row.categoryNameAr ?? '—'}</td>
                    <td className="numeric">{row.quantityOnHand}</td>
                    <td className="numeric font-medium">
                      {formatMoney(row.stockValue, { currency })}
                    </td>
                    <td>
                      {row.lastIssueDate === null ? (
                        <Badge tone="danger">لم يُصرف مطلقاً</Badge>
                      ) : (
                        <span className="bidi-isolate font-mono text-xs">{row.lastIssueDate}</span>
                      )}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {row.daysSinceIssue ?? '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
