import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { getInventoryValuation } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'تقييم المخزون' };

/**
 * Inventory valuation.
 *
 * The whole report is behind the `costPrice` field grant, not just its numeric columns. A
 * valuation report *is* cost data — a row saying "400 units of SKU-1001" with the value hidden
 * still discloses nothing, but the report has no remaining purpose either. Refusing the page
 * is the honest response, rather than rendering an empty shell.
 *
 * The below-reorder count uses the product's company-wide `reorderPoint` against a
 * per-warehouse balance, which over-reports in a multi-warehouse company. Flagged as a hint,
 * never as a purchasing instruction — the same caveat the stock balances screen carries.
 */
export default async function InventoryValuationPage({
  searchParams,
}: {
  searchParams: { warehouse?: string };
}): Promise<JSX.Element> {
  const warehouseId = searchParams.warehouse;

  const result = await withPageScope(async (context) => {
    if (!context.permissions.can('inventory.product', 'read', 'costPrice')) {
      return { denied: true as const };
    }

    const [tenant, warehouses] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
      prisma.warehouse.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
    ]);

    const report = await getInventoryValuation(
      context.tenantId,
      tenant.functionalCurrency,
      warehouseId !== undefined && warehouseId !== 'ALL' ? warehouseId : undefined,
    );

    return {
      denied: false as const,
      report,
      warehouses,
      currency: tenant.functionalCurrency,
    };
  });

  if (result.denied) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">تقييم المخزون</h1>
        </header>
        <Card>
          <CardBody>
            <p className="py-10 text-center text-sm text-muted-foreground">
              هذا التقرير يعرض بيانات التكلفة بالكامل، ويتطلب صلاحية حقلية صريحة على سعر التكلفة.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const { report, warehouses, currency } = result;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">تقييم المخزون</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          القيمة الدفترية للمخزون حسب الصنف والمستودع
        </p>
      </header>

      <Card>
        <form method="get" action="/inventory/valuation" className="flex flex-wrap items-end gap-3 p-5">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">المستودع</span>
            <select
              name="warehouse"
              defaultValue={warehouseId ?? 'ALL'}
              className="h-9 min-w-[14rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="ALL">كل المستودعات</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.code} · {warehouse.nameAr}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            عرض التقرير
          </button>
        </form>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="القيمة الإجمالية" value={formatMoney(report.totalValue, { currency })} />
        <Tile label="عدد السجلات" value={report.rows.length.toString()} />
        <Tile
          label="أصناف دون حد الطلب"
          value={report.belowReorderCount.toString()}
          tone={report.belowReorderCount > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader title="التفصيل" description="مرتّب بالقيمة تنازلياً" />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">المستودع</th>
                <th scope="col" className="numeric">الكمية</th>
                <th scope="col" className="numeric">متوسط التكلفة</th>
                <th scope="col" className="numeric">القيمة</th>
                <th scope="col" className="numeric">حد الطلب</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    لا توجد أرصدة في هذا النطاق
                  </td>
                </tr>
              ) : (
                report.rows.map((row) => (
                  <tr key={`${row.productId}-${row.warehouseNameAr}`}>
                    <td className="max-w-[18rem]">
                      <Link
                        href={`/inventory/products/${row.productId}`}
                        className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                      >
                        {row.sku}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{row.nameAr}</p>
                    </td>
                    <td className="text-xs text-muted-foreground">{row.warehouseNameAr}</td>
                    <td className="numeric">
                      <span className={row.isBelowReorder ? 'font-medium text-warning' : undefined}>
                        {row.quantityOnHand}
                      </span>
                      {row.isBelowReorder ? (
                        <AlertTriangle
                          className="ms-1 inline h-3.5 w-3.5 text-warning"
                          aria-label="دون حد الطلب"
                        />
                      ) : null}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.averageCost, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric font-medium">
                      {formatMoney(row.totalValue, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric text-xs text-muted-foreground">{row.reorderPoint}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={4}>القيمة الإجمالية</td>
                <td className="numeric">
                  {formatMoney(report.totalValue, { currency, showCurrency: false })}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warning';
}): JSX.Element {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          {tone === 'warning' ? <Badge tone="warning">تنبيه</Badge> : null}
        </div>
        <p className="numeric mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      </CardBody>
    </Card>
  );
}
