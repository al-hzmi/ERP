import Link from 'next/link';
import { Package, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الأصناف' };

const PAGE_SIZE = 25;

/**
 * The product register.
 *
 * Two things here are load-bearing rather than decorative.
 *
 * **`costPrice` is withheld unless explicitly granted.** It is in
 * `FIELD_LEVEL_PROTECTED`, which means a plain `inventory.product:read` grant does *not*
 * cover it — that is the whole point of a field-level permission, and the usual way the
 * feature is implemented (resource read implies field read) is why it normally protects
 * nothing. A salesperson can see the catalogue and cannot see what the company paid.
 *
 * **Stock on hand is aggregated in the query, not summed per row in the page.** A register of
 * five hundred products would otherwise issue five hundred aggregate queries, which is the
 * classic N+1 dressed up as a "small helper".
 */

const columnsFor = (canSeeCost: boolean): number => (canSeeCost ? 8 : 7);

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { page?: string; q?: string; category?: string; status?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const query = searchParams.q?.trim();
  const category = searchParams.category;
  const status = searchParams.status ?? 'ACTIVE';

  const { products, total, categories, stockByProduct, canSeeCost, functionalCurrency } =
    await withPageScope(async (context) => {
      const where = {
        tenantId: context.tenantId,
        ...(status === 'ACTIVE' ? { isActive: true } : status === 'INACTIVE' ? { isActive: false } : {}),
        ...(category !== undefined && category !== 'ALL' ? { categoryId: category } : {}),
        ...(query !== undefined && query !== ''
          ? {
              OR: [
                { sku: { contains: query, mode: 'insensitive' as const } },
                { nameAr: { contains: query, mode: 'insensitive' as const } },
                { nameEn: { contains: query, mode: 'insensitive' as const } },
                { barcode: { contains: query, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [loadedProducts, loadedTotal, loadedCategories, tenant] = await Promise.all([
        prisma.product.findMany({
          where,
          select: {
            id: true,
            sku: true,
            nameAr: true,
            barcode: true,
            salePrice: true,
            costPrice: true,
            taxRate: true,
            reorderPoint: true,
            isStockItem: true,
            isActive: true,
            category: { select: { nameAr: true } },
            unitOfMeasure: { select: { code: true } },
          },
          orderBy: { sku: 'asc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        prisma.product.count({ where }),
        prisma.category.findMany({
          where: { tenantId: context.tenantId, isActive: true },
          select: { id: true, nameAr: true },
          orderBy: { code: 'asc' },
        }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: context.tenantId },
          select: { functionalCurrency: true },
        }),
      ]);

      // One grouped query for the whole page rather than one per row.
      const levels = await prisma.stockLevel.groupBy({
        by: ['productId'],
        where: {
          tenantId: context.tenantId,
          productId: { in: loadedProducts.map((product) => product.id) },
        },
        _sum: { quantityOnHand: true },
      });

      return {
        products: loadedProducts,
        total: loadedTotal,
        categories: loadedCategories,
        stockByProduct: new Map(
          levels.map((level) => [level.productId, level._sum.quantityOnHand]),
        ),
        canSeeCost: context.permissions.can('inventory.product', 'read', 'costPrice'),
        functionalCurrency: tenant.functionalCurrency,
      };
    });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { q: query, category, status, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/inventory/products?${params.toString()}`;
  };

  const STATUS_FILTERS = [
    { value: 'ACTIVE', label: 'المتاحة' },
    { value: 'INACTIVE', label: 'الموقوفة' },
    { value: 'ALL', label: 'الكل' },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الأصناف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> صنف — اضغط على الرمز
          لفتح بطاقة الصنف
        </p>
      </header>

      <Card>
        <CardHeader
          title="الكتالوج"
          description={
            canSeeCost
              ? 'سعر التكلفة ظاهر لأن صلاحيتك تشمله صراحةً'
              : 'سعر التكلفة محجوب — يتطلب صلاحية حقلية صريحة'
          }
          action={
            <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب الحالة">
              {STATUS_FILTERS.map((filter) => {
                const active = status === filter.value;
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

        {/* A GET form, so the filter lands in the URL and the page stays shareable and
            bookmarkable — and works with no JavaScript at all. */}
        <form method="get" action="/inventory/products" className="flex flex-wrap gap-2 px-5 pb-4">
          <input type="hidden" name="status" value={status} />
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              name="q"
              defaultValue={query ?? ''}
              placeholder="ابحث بالرمز أو الاسم أو الباركود…"
              aria-label="بحث في الأصناف"
              className="h-9 w-full rounded-md border border-input bg-background ps-9 pe-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <select
            name="category"
            defaultValue={category ?? 'ALL'}
            aria-label="تصفية حسب التصنيف"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">كل التصنيفات</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.nameAr}
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
                <th scope="col">الرمز</th>
                <th scope="col">الصنف</th>
                <th scope="col">التصنيف</th>
                <th scope="col">الوحدة</th>
                <th scope="col" className="numeric">
                  سعر البيع
                </th>
                {canSeeCost ? (
                  <th scope="col" className="numeric">
                    سعر التكلفة
                  </th>
                ) : null}
                <th scope="col" className="numeric">
                  الرصيد
                </th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td
                    colSpan={columnsFor(canSeeCost)}
                    className="py-16 text-center text-muted-foreground"
                  >
                    <Package className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                    لا توجد أصناف مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                products.map((product) => {
                  const onHand = stockByProduct.get(product.id) ?? null;
                  const belowReorder =
                    product.isStockItem &&
                    onHand !== null &&
                    product.reorderPoint.greaterThan(0) &&
                    onHand.lessThanOrEqualTo(product.reorderPoint);

                  return (
                    <tr key={product.id}>
                      <td>
                        <Link
                          href={`/inventory/products/${product.id}`}
                          className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                        >
                          {product.sku}
                        </Link>
                      </td>
                      <td className="max-w-[18rem]">
                        <p className="truncate">{product.nameAr}</p>
                        {product.barcode !== null ? (
                          <p className="bidi-isolate text-[11px] text-muted-foreground">
                            {product.barcode}
                          </p>
                        ) : null}
                      </td>
                      <td className="text-xs text-muted-foreground">{product.category.nameAr}</td>
                      <td className="bidi-isolate text-xs text-muted-foreground">
                        {product.unitOfMeasure.code}
                      </td>
                      <td className="numeric font-medium">
                        {formatMoney(product.salePrice.toFixed(4), {
                          currency: functionalCurrency,
                          showCurrency: false,
                        })}
                      </td>
                      {canSeeCost ? (
                        <td className="numeric text-muted-foreground">
                          {formatMoney(product.costPrice.toFixed(4), {
                            currency: functionalCurrency,
                            showCurrency: false,
                          })}
                        </td>
                      ) : null}
                      <td className="numeric">
                        {!product.isStockItem ? (
                          <span className="text-xs text-muted-foreground">خدمة</span>
                        ) : (
                          <span className={belowReorder ? 'font-medium text-warning' : undefined}>
                            {(onHand ?? 0).toString()}
                          </span>
                        )}
                      </td>
                      <td>
                        {product.isActive ? (
                          <Badge tone="success">متاح</Badge>
                        ) : (
                          <Badge tone="neutral">موقوف</Badge>
                        )}
                        {belowReorder ? (
                          <Badge tone="warning" className="ms-1">
                            دون حد الطلب
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
    </div>
  );
}
