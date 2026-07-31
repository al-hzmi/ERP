import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getSalesByProduct } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'هوامش الربح' };

/**
 * Profit margins, worst first.
 *
 * The same data as sales-by-product, ordered by the question this screen asks instead: which
 * products are being sold at or below cost. Sorting ascending puts the loss-makers at the top,
 * which is the entire reason to open this rather than the sales report.
 *
 * **The whole screen is behind the `costPrice` field grant.** A margin is cost data by
 * subtraction — publishing the margin and the revenue publishes the cost — so without the grant
 * this refuses rather than rendering a version with the interesting columns removed.
 *
 * Products that sold nothing carry `marginPercent === null` and are excluded from the ranking
 * rather than sorted as if they were 0%: no sales is not a bad margin.
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

    const canSeeCost = context.permissions.can('inventory.product', 'read', 'costPrice');

    return {
      rows: canSeeCost
        ? await getSalesByProduct({
            tenantId: context.tenantId,
            fromDate: new Date(`${fromDate}T00:00:00.000Z`),
            toDate: new Date(`${toDate}T00:00:00.000Z`),
            currency: tenant.functionalCurrency,
          })
        : [],
      currency: tenant.functionalCurrency,
      canSeeCost,
    };
  });

  if (!canSeeCost) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">هوامش الربح</h1>
        </header>
        <Card>
          <CardBody className="py-16 text-center text-muted-foreground">
            هذا التقرير بيانات تكلفة بالكامل — الهامش مع الإيراد يكشف التكلفة بالطرح — ولا يظهر
            بدون صلاحية الاطلاع على التكلفة.
          </CardBody>
        </Card>
      </div>
    );
  }

  // Worst first. Products with no sales have a null percentage and are listed after the ranked
  // ones rather than sorted as if they were a 0% margin.
  const ranked = rows
    .filter((row) => row.marginPercent !== null)
    .sort((a, b) => Number(a.marginPercent) - Number(b.marginPercent));

  const losing = ranked.filter((row) => Number(row.marginPercent) < 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">هوامش الربح</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مرتَّبة تصاعدياً — الأصناف الخاسرة أولاً، بين {fromDate} و{toDate}
        </p>
      </header>

      <ReportFilters action="/sales/margins" fromDate={fromDate} toDate={toDate} />

      {losing.length > 0 ? (
        <Card>
          <CardBody className="border-s-4 border-s-destructive text-sm">
            <span className="font-medium text-destructive">
              {losing.length} صنفاً بيع بهامش سالب
            </span>{' '}
            <span className="text-muted-foreground">
              — الإيراد أقل من تكلفة ما صُرف فعلاً من المخزون.
            </span>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="الهوامش"
          description={`${ranked.length} صنفاً بيع خلال الفترة — التكلفة من طبقات التكلفة المستهلَكة`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">التصنيف</th>
                <th scope="col" className="numeric">الكمية</th>
                <th scope="col" className="numeric">الإيراد</th>
                <th scope="col" className="numeric">التكلفة</th>
                <th scope="col" className="numeric">الهامش</th>
                <th scope="col" className="numeric">النسبة</th>
              </tr>
            </thead>
            <tbody>
              {ranked.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    لا توجد مبيعات خلال هذه الفترة
                  </td>
                </tr>
              ) : (
                ranked.map((row) => {
                  const percent = Number(row.marginPercent);
                  return (
                    <tr key={row.productId}>
                      <td className="max-w-[18rem]">
                        <p className="bidi-isolate font-mono text-[11px] text-primary">{row.sku}</p>
                        <p className="truncate">{row.nameAr}</p>
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {row.categoryNameAr ?? '—'}
                      </td>
                      <td className="numeric">{row.quantitySold}</td>
                      <td className="numeric">{formatMoney(row.netSales, { currency })}</td>
                      <td className="numeric text-muted-foreground">
                        {formatMoney(row.cost, { currency })}
                      </td>
                      <td className="numeric font-medium">
                        {formatMoney(row.margin, { currency })}
                      </td>
                      <td className="numeric">
                        {percent < 0 ? (
                          <Badge tone="danger">{row.marginPercent}%</Badge>
                        ) : percent < 10 ? (
                          <Badge tone="warning">{row.marginPercent}%</Badge>
                        ) : (
                          <span className="text-muted-foreground">{row.marginPercent}%</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
