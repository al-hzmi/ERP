import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * Stock balances as JSON.
 *
 * Totals are aggregated over the whole filtered set and returned alongside the page, because
 * a caller paging through five hundred rows to compute a total is five hundred round trips to
 * answer a question PostgreSQL answers in one.
 *
 * Valuation fields are withheld without the `costPrice` field grant: `averageCost` and
 * `totalValue` disclose what the company paid just as directly as the cost price does, and
 * protecting one while returning the others would be protection in name only.
 */
export const GET = apiHandler(
  async (context, request) => {
    const { page, pageSize, skip } = parsePagination(request);
    const url = new URL(request.url);
    const warehouseId = url.searchParams.get('warehouseId');
    const productId = url.searchParams.get('productId');
    const includeZero = url.searchParams.get('includeZero') === 'true';

    const canSeeValue = context.permissions.can('inventory.product', 'read', 'costPrice');

    const where = {
      tenantId: context.tenantId,
      ...(warehouseId !== null && warehouseId !== '' ? { warehouseId } : {}),
      ...(productId !== null && productId !== '' ? { productId } : {}),
      ...(includeZero ? {} : { quantityOnHand: { gt: 0 } }),
    };

    const { items, total, sums } = await withTenantRead(async (tx) => ({
      items: await tx.stockLevel.findMany({
        where,
        select: {
          id: true,
          quantityOnHand: true,
          quantityReserved: true,
          lastMovementAt: true,
          ...(canSeeValue ? { averageCost: true, totalValue: true } : {}),
          product: { select: { id: true, sku: true, nameAr: true, reorderPoint: true } },
          warehouse: { select: { id: true, code: true, nameAr: true } },
        },
        orderBy: [{ totalValue: 'desc' }, { productId: 'asc' }],
        skip,
        take: pageSize,
      }),
      total: await tx.stockLevel.count({ where }),
      sums: await tx.stockLevel.aggregate({
        where,
        _sum: { quantityOnHand: true, ...(canSeeValue ? { totalValue: true } : {}) },
      }),
    }));

    return ok({
      ...paginated(items, total, { page, pageSize }),
      totals: {
        quantityOnHand: (sums._sum.quantityOnHand ?? 0).toString(),
        ...(canSeeValue ? { totalValue: (sums._sum.totalValue ?? 0).toString() } : {}),
      },
    });
  },
  { permission: { resource: 'inventory.stock', action: 'read' } },
);
