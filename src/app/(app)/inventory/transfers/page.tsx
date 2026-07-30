import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { StockOperationForm } from '@/components/inventory/stock-operation-form';
import { withPageScope } from '@/lib/api/page';
import { listStockOperations } from '@/lib/application/services/stock-operations-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'التحويلات المخزنية' };

const PAGE_SIZE = 25;

/**
 * التحويلات المخزنية.
 *
 * Entry and register on one page. These are short operations a warehouse clerk performs in a
 * run — a separate "new" route would mean a round trip per movement, and the register directly
 * under the form is the confirmation that the last one landed.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { page?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);

  const { rows, total, currency, canCreate } = await withPageScope(async (context) => {
    const [listed, tenant] = await Promise.all([
      listStockOperations({
        tenantId: context.tenantId,
        kind: 'TRANSFER',
        page,
        pageSize: PAGE_SIZE,
      }),
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    return {
      ...listed,
      currency: tenant.functionalCurrency,
      canCreate: context.permissions.can('inventory.transfer', 'create'),
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">التحويلات المخزنية</h1>
        <p className="mt-1 text-sm text-muted-foreground">نقل الأصناف بين المستودعات — القيمة لا تغادر المنشأة فلا قيد محاسبي</p>
      </header>

      {canCreate ? (
        <StockOperationForm mode="TRANSFER" />
      ) : (
        <Card>
          <div className="p-6 text-center text-sm text-muted-foreground">
            صلاحيتك تسمح بالاطلاع فقط — التنفيذ يتطلب <span className="bidi-isolate font-mono">inventory.transfer:create</span>.
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="السجل"
          description={`${total.toLocaleString('en-US')} حركة — الأحدث أولاً`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الحركة</th>
                <th scope="col">التاريخ</th>
                <th scope="col">الصنف</th>
                <th scope="col">المستودع</th>
                <th scope="col" className="numeric">الكمية</th>
                <th scope="col" className="numeric">القيمة</th>
                <th scope="col">البيان</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    لا توجد حركات مسجَّلة بعد
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="bidi-isolate font-mono text-xs text-primary">
                      {row.movementNumber}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {formatDate(row.movementDate, { calendar: 'gregorian', style: 'medium' })}
                    </td>
                    <td className="max-w-[16rem]">
                      <span className="bidi-isolate font-mono text-xs text-muted-foreground">
                        {row.product.sku}
                      </span>
                      <p className="truncate text-xs">{row.product.nameAr}</p>
                    </td>
                    <td className="text-xs">
                      <span className="bidi-isolate font-mono">{row.warehouse.code}</span>
                      {row.fromWarehouse !== null && row.toWarehouse !== null ? (
                        <span className="bidi-isolate ms-1 text-[11px] text-muted-foreground">
                          {row.fromWarehouse.code} → {row.toWarehouse.code}
                        </span>
                      ) : null}
                    </td>
                    <td className="numeric font-medium">{row.quantity}</td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.totalCost, { currency, showCurrency: false })}
                    </td>
                    <td className="max-w-[18rem] truncate text-xs text-muted-foreground">
                      {row.notes ?? '—'}
                      {row.transferGroupId !== null ? (
                        <Badge tone="info" className="ms-1">مرتبطة</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))
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
              <a
                href={`/inventory/transfers?page=${Math.max(1, page - 1)}`}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </a>
              <a
                href={`/inventory/transfers?page=${Math.min(totalPages, page + 1)}`}
                className={
                  page === totalPages
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                التالي
              </a>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
