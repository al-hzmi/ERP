import { Card, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getSalesByProduct } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'المبيعات حسب الصنف' };

/**
 * Sales by product.
 *
 * The cost and margin columns are dropped entirely without the `costPrice` field grant rather
 * than blanked — a blanked column still tells the reader those figures exist and that they are
 * not allowed to see them, which is more than the grant intends to disclose. Same treatment as
 * `/inventory/valuation`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const fromDate = parseReportDate(searchParams.from, fallback.from);
  const toDate = parseReportDate(searchParams.to, fallback.to);

  const { rows, currency, canSeeCost } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      rows: await getSalesByProduct({
        tenantId: context.tenantId,
        fromDate: new Date(`${fromDate}T00:00:00.000Z`),
        toDate: new Date(`${toDate}T00:00:00.000Z`),
        currency: tenant.functionalCurrency,
      }),
      currency: tenant.functionalCurrency,
      canSeeCost: context.permissions.can('inventory.product', 'read', 'costPrice'),
    };
  });

  const columns = canSeeCost ? 7 : 4;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">المبيعات حسب الصنف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          الكميات والإيراد لكل صنف بين {fromDate} و{toDate}
        </p>
      </header>

      <ReportFilters action="/sales/analysis-by-product" fromDate={fromDate} toDate={toDate} />

      <Card>
        <CardHeader
          title="المبيعات حسب الصنف"
          description={
            canSeeCost
              ? `${rows.length} صنفاً — التكلفة من حركات المخزون الفعلية لا من التكلفة المعيارية`
              : `${rows.length} صنفاً`
          }
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">التصنيف</th>
                <th scope="col" className="numeric">الكمية</th>
                <th scope="col" className="numeric">صافي المبيعات</th>
                {canSeeCost ? (
                  <>
                    <th scope="col" className="numeric">التكلفة</th>
                    <th scope="col" className="numeric">هامش الربح</th>
                    <th scope="col" className="numeric">النسبة</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns} className="py-16 text-center text-muted-foreground">
                    لا توجد مبيعات خلال هذه الفترة
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
                    <td className="numeric">{row.quantitySold}</td>
                    <td className="numeric font-medium">
                      {formatMoney(row.netSales, { currency })}
                    </td>
                    {canSeeCost ? (
                      <>
                        <td className="numeric text-muted-foreground">
                          {formatMoney(row.cost, { currency })}
                        </td>
                        <td className="numeric">{formatMoney(row.margin, { currency })}</td>
                        <td className="numeric text-muted-foreground">
                          {row.marginPercent === null ? '—' : `${row.marginPercent}%`}
                        </td>
                      </>
                    ) : null}
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
