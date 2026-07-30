import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * The product catalogue as JSON.
 *
 * `costPrice` is omitted from the projection entirely when the caller lacks the field-level
 * grant, rather than fetched and blanked. A value that reaches the response object and is
 * overwritten there is one refactor away from being serialised — the safe version never
 * loads it.
 */
export const GET = apiHandler(
  async (context, request) => {
    const { page, pageSize, skip } = parsePagination(request);
    const url = new URL(request.url);
    const query = url.searchParams.get('q')?.trim();
    const categoryId = url.searchParams.get('categoryId');
    const includeInactive = url.searchParams.get('includeInactive') === 'true';

    const canSeeCost = context.permissions.can('inventory.product', 'read', 'costPrice');

    const where = {
      tenantId: context.tenantId,
      ...(includeInactive ? {} : { isActive: true }),
      ...(categoryId !== null && categoryId !== '' ? { categoryId } : {}),
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

    const { items, total } = await withTenantRead(async (tx) => ({
      items: await tx.product.findMany({
        where,
        select: {
          id: true,
          sku: true,
          nameAr: true,
          nameEn: true,
          barcode: true,
          salePrice: true,
          taxRate: true,
          reorderPoint: true,
          isStockItem: true,
          isActive: true,
          ...(canSeeCost ? { costPrice: true } : {}),
          category: { select: { id: true, nameAr: true } },
          unitOfMeasure: { select: { code: true } },
        },
        orderBy: { sku: 'asc' },
        skip,
        take: pageSize,
      }),
      total: await tx.product.count({ where }),
    }));

    return ok(paginated(items, total, { page, pageSize }));
  },
  { permission: { resource: 'inventory.product', action: 'read' } },
);
