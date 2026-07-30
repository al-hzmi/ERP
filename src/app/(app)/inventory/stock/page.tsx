import Link from 'next/link';
import { AlertTriangle, Warehouse as WarehouseIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'أرصدة المخزون' };

const PAGE_SIZE = 30;

/**
 * Stock balances.
 *
 * The product card answers "where is this product"; this answers the inverse — "what is in
 * this warehouse, and what is it worth" — which is the question asked at a stock count and at
 * a period close.
 *
 * **Valuation totals come from a database aggregate over the whole filtered set, not from
 * summing the visible page.** A page shows thirty rows; a warehouse holds five hundred. A
 * footer that summed only what is on screen would be wrong in a way that looks right, and
 * would change as the user paged.
 *
 * **`totalValue` is read, never recomputed as `quantity × averageCost`.** Those two agree only
 * while nothing has drifted, and migration 2's consistency guard is what keeps them agreeing.
 * Recomputing here would hide exactly the drift that guard exists to surface.
 *
 * **Below-reorder rows are flagged against the product's `reorderPoint` per warehouse**, and
 * that is a deliberate simplification worth naming: a reorder point is a company-wide figure
 * on the product, so comparing it to one warehouse's balance over-reports in a
 * multi-warehouse company. It is shown as a hint, not as a purchasing instruction, and a
 * per-warehouse reorder point is what a real replenishment feature would need.
 */
export default async function StockBalancesPage({
  searchParams,
}: {
  searchParams: { page?: string; warehouse?: string; only?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const warehouseId = searchParams.warehouse;
  const only = searchParams.only ?? 'STOCKED';

  const { levels, total, warehouses, totals, currency, canSeeValue } = await withPageScope(
    async (context) => {
      const where = {
        tenantId: context.tenantId,
        ...(warehouseId !== undefined && warehouseId !== 'ALL' ? { warehouseId } : {}),
        // "Stocked" hides the thousands of zero rows a full catalogue × warehouse matrix
        // produces, which is what makes the screen usable at all.
        ...(only === 'STOCKED' ? { quantityOnHand: { gt: 0 } } : {}),
      };

      const [loadedLevels, loadedTotal, loadedWarehouses, aggregate, tenant] = await Promise.all([
        prisma.stockLevel.findMany({
          where,
          select: {
            id: true,
            quantityOnHand: true,
            quantityReserved: true,
            averageCost: true,
            totalValue: true,
            lastMovementAt: true,
            product: {
              select: { id: true, sku: true, nameAr: true, reorderPoint: true },
            },
            warehouse: { select: { code: true, nameAr: true } },
          },
          orderBy: [{ totalValue: 'desc' }, { productId: 'asc' }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        prisma.stockLevel.count({ where }),
        prisma.warehouse.findMany({
          where: { tenantId: context.tenantId, isActive: true },
          select: { id: true, code: true, nameAr: true },
          orderBy: { code: 'asc' },
        }),
        // Over the filtered set, not over the page.
        prisma.stockLevel.aggregate({
          where,
          _sum: { quantityOnHand: true, totalValue: true },
        }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: context.tenantId },
          select: { functionalCurrency: true },
        }),
      ]);

      return {
        levels: loadedLevels,
        total: loadedTotal,
        warehouses: loadedWarehouses,
        totals: aggregate._sum,
        currency: tenant.functionalCurrency,
        canSeeValue: context.permissions.can('inventory.product', 'read', 'costPrice'),
      };
    },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { warehouse: warehouseId, only, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/inventory/stock?${params.toString()}`;
  };

  const belowReorderCount = levels.filter(
    (level) =>
      level.product.reorderPoint.greaterThan(0) &&
      level.quantityOnHand.lessThanOrEqualTo(level.product.reorderPoint),
  ).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">أرصدة المخزون</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> سجل رصيد
          {warehouseId !== undefined && warehouseId !== 'ALL' ? ' في المستودع المحدد' : ' عبر كل المستودعات'}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryTile
          label="إجمالي الكميات"
          value={(totals.quantityOnHand ?? 0).toString()}
          hint="مجموع الكميات عبر كل الصفحات، لا الصفحة الظاهرة"
        />
        {canSeeValue ? (
          <SummaryTile
            label="قيمة المخزون"
            value={formatMoney((totals.totalValue ?? 0).toString(), { currency })}
            hint="مقروءة من totalValue لا محسوبة من الكمية × التكلفة"
          />
        ) : (
          <SummaryTile label="قيمة المخزون" value="محجوبة" hint="تتطلب صلاحية حقلية صريحة" />
        )}
        <SummaryTile
          label="أصناف دون حد الطلب"
          value={belowReorderCount.toString()}
          hint="في هذه الصفحة — حد الطلب معرَّف على مستوى الصنف لا المستودع"
          tone={belowReorderCount > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader
          title="الأرصدة"
          description="مرتّبة بالقيمة تنازلياً — أعلى ما في المستودع أولاً"
          action={
            <div className="flex flex-wrap gap-1">
              <Link
                href={queryFor({ only: only === 'STOCKED' ? 'ALL' : 'STOCKED', page: '1' })}
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
              >
                {only === 'STOCKED' ? 'إظهار الأصفار' : 'إخفاء الأصفار'}
              </Link>
            </div>
          }
        />

        <form method="get" action="/inventory/stock" className="flex flex-wrap gap-2 px-5 pb-4">
          <input type="hidden" name="only" value={only} />
          <select
            name="warehouse"
            defaultValue={warehouseId ?? 'ALL'}
            aria-label="تصفية حسب المستودع"
            className="h-9 min-w-[14rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">كل المستودعات</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.nameAr}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            تصفية
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col">المستودع</th>
                <th scope="col" className="numeric">
                  المتاح
                </th>
                <th scope="col" className="numeric">
                  المحجوز
                </th>
                {canSeeValue ? (
                  <>
                    <th scope="col" className="numeric">
                      متوسط التكلفة
                    </th>
                    <th scope="col" className="numeric">
                      القيمة
                    </th>
                  </>
                ) : null}
                <th scope="col">آخر حركة</th>
              </tr>
            </thead>
            <tbody>
              {levels.length === 0 ? (
                <tr>
                  <td
                    colSpan={canSeeValue ? 7 : 5}
                    className="py-16 text-center text-muted-foreground"
                  >
                    <WarehouseIcon className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                    لا توجد أرصدة مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                levels.map((level) => {
                  const belowReorder =
                    level.product.reorderPoint.greaterThan(0) &&
                    level.quantityOnHand.lessThanOrEqualTo(level.product.reorderPoint);

                  return (
                    <tr key={level.id}>
                      <td className="max-w-[18rem]">
                        <Link
                          href={`/inventory/products/${level.product.id}`}
                          className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                        >
                          {level.product.sku}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {level.product.nameAr}
                        </p>
                      </td>
                      <td>
                        <span className="bidi-isolate font-mono text-xs">
                          {level.warehouse.code}
                        </span>
                      </td>
                      <td className="numeric font-medium">
                        <span className={belowReorder ? 'text-warning' : undefined}>
                          {level.quantityOnHand.toString()}
                        </span>
                        {belowReorder ? (
                          <AlertTriangle
                            className="ms-1 inline h-3.5 w-3.5 text-warning"
                            aria-label="دون حد الطلب"
                          />
                        ) : null}
                      </td>
                      <td className="numeric text-muted-foreground">
                        {level.quantityReserved.toString()}
                      </td>
                      {canSeeValue ? (
                        <>
                          <td className="numeric text-muted-foreground">
                            {formatMoney(level.averageCost.toFixed(4), {
                              currency,
                              showCurrency: false,
                            })}
                          </td>
                          <td className="numeric font-medium">
                            {formatMoney(level.totalValue.toFixed(4), {
                              currency,
                              showCurrency: false,
                            })}
                          </td>
                        </>
                      ) : null}
                      <td className="whitespace-nowrap text-xs text-muted-foreground">
                        {level.lastMovementAt === null
                          ? '—'
                          : formatDate(level.lastMovementAt, { style: 'medium' })}
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
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
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
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      </CardBody>
    </Card>
  );
}
