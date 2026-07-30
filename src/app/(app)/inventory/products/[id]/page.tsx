import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'بطاقة الصنف' };

const MOVEMENT_LABELS: Record<string, string> = {
  IN: 'إدخال',
  OUT: 'إخراج',
  TRANSFER: 'تحويل',
  ADJUSTMENT: 'تسوية',
  OPENING: 'رصيد افتتاحي',
};

/**
 * The product card.
 *
 * The register answers "which products exist"; this answers "what is true about this one",
 * and the three panels are chosen because they are the three questions actually asked of a
 * product record: what are its terms, where is its stock, and what has happened to it.
 *
 * **Stock is shown per warehouse and never as a single number.** A total of 400 units across
 * ten branches does not tell a salesperson in Jeddah whether they can promise delivery, and
 * presenting one figure invites exactly that mistake. The total is shown too, in the footer,
 * where it reads as a sum rather than as availability.
 *
 * **Valuation is read from `totalValue`, not recomputed as quantity × average cost.** Those
 * two agree only if nothing has drifted, and `erp_stock_value_consistency` is what keeps them
 * agreeing. Recomputing here would silently paper over a drift the seed's own verification
 * exists to catch.
 *
 * `costPrice`, `averageCost` and stock valuation are all withheld without the explicit
 * field-level grant, for the same reason the register withholds cost: a resource-level read
 * that implied field access would make the protection decorative.
 */
export default async function ProductCardPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const data = await withPageScope(async (context) => {
    const product = await prisma.product.findFirst({
      where: { id: params.id, tenantId: context.tenantId },
      select: {
        id: true,
        sku: true,
        nameAr: true,
        nameEn: true,
        description: true,
        barcode: true,
        salePrice: true,
        costPrice: true,
        taxRate: true,
        reorderPoint: true,
        costingMethod: true,
        isStockItem: true,
        trackExpiry: true,
        trackBatch: true,
        trackSerial: true,
        isActive: true,
        category: { select: { nameAr: true } },
        brand: { select: { nameAr: true } },
        unitOfMeasure: { select: { code: true, nameAr: true } },
      },
    });

    if (product === null) return null;

    const [levels, movements, tenant] = await Promise.all([
      prisma.stockLevel.findMany({
        where: { tenantId: context.tenantId, productId: product.id },
        select: {
          id: true,
          quantityOnHand: true,
          quantityReserved: true,
          averageCost: true,
          totalValue: true,
          lastMovementAt: true,
          warehouse: { select: { code: true, nameAr: true } },
        },
        orderBy: { warehouse: { code: 'asc' } },
      }),
      prisma.inventoryMovement.findMany({
        where: { tenantId: context.tenantId, productId: product.id },
        select: {
          id: true,
          movementNumber: true,
          type: true,
          movementDate: true,
          quantity: true,
          unitCost: true,
          balanceAfter: true,
          referenceType: true,
          warehouse: { select: { code: true } },
        },
        orderBy: [{ movementDate: 'desc' }, { movementNumber: 'desc' }],
        take: 20,
      }),
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    return {
      product,
      levels,
      movements,
      currency: tenant.functionalCurrency,
      canSeeCost: context.permissions.can('inventory.product', 'read', 'costPrice'),
    };
  });

  // `notFound()` rather than an error page: another tenant's product and a deleted one are
  // indistinguishable from here, and they should be — saying "exists, but not yours" would
  // confirm the id.
  if (data === null) notFound();

  const { product, levels, movements, currency, canSeeCost } = data;

  // Summed as `Decimal`, seeded from a real value so the zero carries the column's scale.
  // `reduce` over `Number` would reintroduce floating point on a quantity that the whole
  // schema keeps exact.
  const first = levels[0];
  const totalOnHand =
    first === undefined
      ? null
      : levels
          .slice(1)
          .reduce((sum, level) => sum.plus(level.quantityOnHand), first.quantityOnHand);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/inventory/products"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          عودة إلى الأصناف
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{product.nameAr}</h1>
            {product.isActive ? (
              <Badge tone="success">متاح</Badge>
            ) : (
              <Badge tone="neutral">موقوف</Badge>
            )}
            {!product.isStockItem ? <Badge tone="info">خدمة</Badge> : null}
          </div>
          <p className="bidi-isolate mt-1 font-mono text-sm text-muted-foreground">{product.sku}</p>
        </div>
        {product.isStockItem ? (
          <Link
            href={`/inventory/stock-card?productId=${product.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
            بطاقة الحركة التفصيلية
          </Link>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="البيانات الأساسية" />
          <CardBody>
            <dl className="space-y-2.5 text-sm">
              <Row label="الاسم بالإنجليزية" value={product.nameEn} isolate />
              <Row label="التصنيف" value={product.category.nameAr} />
              <Row label="الماركة" value={product.brand?.nameAr ?? '—'} />
              <Row
                label="الوحدة"
                value={`${product.unitOfMeasure.nameAr} (${product.unitOfMeasure.code})`}
              />
              <Row label="الباركود" value={product.barcode ?? '—'} isolate />
              <Row
                label="سعر البيع"
                value={formatMoney(product.salePrice.toFixed(4), { currency })}
                numeric
              />
              {canSeeCost ? (
                <Row
                  label="سعر التكلفة"
                  value={formatMoney(product.costPrice.toFixed(4), { currency })}
                  numeric
                />
              ) : (
                <Row label="سعر التكلفة" value="محجوب — يتطلب صلاحية حقلية" />
              )}
              <Row label="نسبة الضريبة" value={`${product.taxRate.toFixed(2)}%`} numeric />
              {product.isStockItem ? (
                <>
                  <Row label="حد إعادة الطلب" value={product.reorderPoint.toString()} numeric />
                  <Row label="طريقة التكلفة" value={product.costingMethod ?? 'حسب سياسة المنشأة'} />
                </>
              ) : null}
            </dl>

            {product.trackExpiry || product.trackBatch || product.trackSerial ? (
              <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                {product.trackBatch ? <Badge tone="info">تتبّع الدفعات</Badge> : null}
                {product.trackExpiry ? <Badge tone="info">تتبّع الصلاحية</Badge> : null}
                {product.trackSerial ? <Badge tone="info">تتبّع الأرقام التسلسلية</Badge> : null}
              </div>
            ) : null}

            {product.description !== null && product.description !== '' ? (
              <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                {product.description}
              </p>
            ) : null}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="الرصيد حسب المستودع"
            description="الإجمالي لا يعني التوفر — الرصيد في مستودع آخر لا يخدم طلباً هنا"
          />
          {!product.isStockItem ? (
            <CardBody>
              <p className="py-6 text-center text-sm text-muted-foreground">
                هذا الصنف خدمي ولا يُخزَّن.
              </p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">المستودع</th>
                    <th scope="col" className="numeric">
                      المتاح
                    </th>
                    <th scope="col" className="numeric">
                      المحجوز
                    </th>
                    {canSeeCost ? (
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
                        colSpan={canSeeCost ? 6 : 4}
                        className="py-10 text-center text-muted-foreground"
                      >
                        لا يوجد رصيد لهذا الصنف في أي مستودع
                      </td>
                    </tr>
                  ) : (
                    levels.map((level) => (
                      <tr key={level.id}>
                        <td>
                          <span className="bidi-isolate font-mono text-xs text-primary">
                            {level.warehouse.code}
                          </span>
                          <span className="ms-2 text-xs text-muted-foreground">
                            {level.warehouse.nameAr}
                          </span>
                        </td>
                        <td className="numeric font-medium">{level.quantityOnHand.toString()}</td>
                        <td className="numeric text-muted-foreground">
                          {level.quantityReserved.toString()}
                        </td>
                        {canSeeCost ? (
                          <>
                            <td className="numeric text-muted-foreground">
                              {formatMoney(level.averageCost.toFixed(4), {
                                currency,
                                showCurrency: false,
                              })}
                            </td>
                            <td className="numeric">
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
                    ))
                  )}
                </tbody>
                {levels.length > 0 && totalOnHand !== null ? (
                  <tfoot>
                    <tr className="font-medium">
                      <td>الإجمالي عبر المستودعات</td>
                      <td className="numeric">{totalOnHand.toString()}</td>
                      <td colSpan={canSeeCost ? 4 : 2} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="آخر الحركات" description="أحدث عشرين حركة على هذا الصنف" />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الحركة</th>
                <th scope="col">التاريخ</th>
                <th scope="col">النوع</th>
                <th scope="col">المستودع</th>
                <th scope="col" className="numeric">
                  الكمية
                </th>
                {canSeeCost ? (
                  <th scope="col" className="numeric">
                    تكلفة الوحدة
                  </th>
                ) : null}
                <th scope="col" className="numeric">
                  الرصيد بعدها
                </th>
                <th scope="col">المرجع</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td
                    colSpan={canSeeCost ? 8 : 7}
                    className="py-10 text-center text-muted-foreground"
                  >
                    لا توجد حركات مسجَّلة على هذا الصنف
                  </td>
                </tr>
              ) : (
                movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="bidi-isolate font-mono text-xs text-primary">
                      {movement.movementNumber}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {formatDate(movement.movementDate, {
                        calendar: 'gregorian',
                        style: 'medium',
                      })}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {MOVEMENT_LABELS[movement.type] ?? movement.type}
                    </td>
                    <td className="bidi-isolate font-mono text-xs text-muted-foreground">
                      {movement.warehouse.code}
                    </td>
                    <td className="numeric font-medium">{movement.quantity.toString()}</td>
                    {canSeeCost ? (
                      <td className="numeric text-muted-foreground">
                        {formatMoney(movement.unitCost.toFixed(4), {
                          currency,
                          showCurrency: false,
                        })}
                      </td>
                    ) : null}
                    <td className="numeric text-muted-foreground">
                      {movement.balanceAfter.toString()}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {movement.referenceType ?? '—'}
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

function Row({
  label,
  value,
  numeric = false,
  isolate = false,
}: {
  label: string;
  value: string;
  numeric?: boolean;
  isolate?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={[
          'min-w-0 text-end',
          numeric ? 'numeric font-medium' : '',
          isolate ? 'bidi-isolate' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}
