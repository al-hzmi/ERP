import { Card, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getMovementAnalysis } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'حركة الأصناف' };

/**
 * What moved in and out over a period.
 *
 * Direction is derived from the running `balanceAfter`, not from the movement type — see
 * `getMovementAnalysis`. `ADJUSTMENT` is written for both directions, so classifying on type
 * would guess wrong on exactly the movements this report exists to explain.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; warehouse?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const fromDate = parseReportDate(searchParams.from, fallback.from);
  const toDate = parseReportDate(searchParams.to, fallback.to);

  const { rows, warehouses, currency } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      rows: await getMovementAnalysis({
        tenantId: context.tenantId,
        fromDate: new Date(`${fromDate}T00:00:00.000Z`),
        toDate: new Date(`${toDate}T00:00:00.000Z`),
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">حركة الأصناف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          الوارد والصادر لكل صنف بين {fromDate} و{toDate}
        </p>
      </header>

      <ReportFilters
        action="/inventory/movement-analysis"
        fromDate={fromDate}
        toDate={toDate}
        extra={
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
        }
      />

      <Card>
        <CardHeader title="الحركة" description={`${rows.length} صنفاً تحرك خلال الفترة`} />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">التصنيف</th>
                <th scope="col" className="numeric">وارد</th>
                <th scope="col" className="numeric">صادر</th>
                <th scope="col" className="numeric">الصافي</th>
                <th scope="col" className="numeric">قيمة الوارد</th>
                <th scope="col" className="numeric">قيمة الصادر</th>
                <th scope="col" className="numeric">عدد الحركات</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-muted-foreground">
                    لا توجد حركة خلال هذه الفترة
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
                    <td className="numeric">{row.quantityIn}</td>
                    <td className="numeric">{row.quantityOut}</td>
                    <td className="numeric font-medium">{row.netQuantity}</td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.valueIn, { currency })}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.valueOut, { currency })}
                    </td>
                    <td className="numeric text-muted-foreground">{row.movementCount}</td>
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
