import { Prisma } from '@prisma/client';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * The stock card: one product's movement history, with a running balance.
 *
 * The running balance is read from `balanceAfter` on each movement rather than
 * accumulated here. That column exists precisely so this screen is O(rows returned)
 * instead of O(all history): summing forward from the beginning of time to show the
 * last page of a product with four years of movements would read every row to
 * display twenty.
 *
 * The consequence worth stating: `balanceAfter` is per warehouse, written by the
 * inventory service under a row lock. Asking for a card *across* warehouses would
 * interleave two independent running balances into a column of nonsense, so a
 * warehouse is required rather than optional.
 */

const MAX_ROWS = 500;

export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);
    const productId = url.searchParams.get('productId');
    const warehouseId = url.searchParams.get('warehouseId');

    if (productId === null || productId === '') {
      return err(
        DomainErrors.validation('يجب تحديد الصنف.', 'A product must be specified.', 'productId'),
      );
    }

    if (warehouseId === null || warehouseId === '') {
      return err(
        DomainErrors.validation(
          'يجب تحديد المستودع — الرصيد الجاري يُحسب لكل مستودع على حدة.',
          'A warehouse must be specified: the running balance is kept per warehouse.',
          'warehouseId',
        ),
      );
    }

    const year = new Date().getUTCFullYear();
    const from = DateOnly.create(url.searchParams.get('from') ?? `${year}-01-01`);
    const to = DateOnly.create(url.searchParams.get('to') ?? DateOnly.today().toString());

    if (!from.ok) return from;
    if (!to.ok) return to;

    if (from.value.isAfter(to.value)) {
      return err(
        DomainErrors.validation(
          'تاريخ البداية يجب أن يسبق تاريخ النهاية.',
          'The start date must be on or before the end date.',
          'from',
        ),
      );
    }

    const card = await withTenantRead(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: context.tenantId },
        select: {
          id: true,
          sku: true,
          nameAr: true,
          nameEn: true,
          costingMethod: true,
          unitOfMeasure: { select: { code: true, nameAr: true } },
        },
      });

      if (product === null) return null;

      const warehouse = await tx.warehouse.findFirst({
        where: { id: warehouseId, tenantId: context.tenantId },
        select: { id: true, code: true, nameAr: true },
      });

      if (warehouse === null) return { product, warehouse: null } as const;

      const [movements, stockLevel, openingMovement] = await Promise.all([
        tx.inventoryMovement.findMany({
          where: {
            tenantId: context.tenantId,
            productId,
            warehouseId,
            movementDate: { gte: from.value.toDate(), lte: to.value.toDate() },
          },
          select: {
            id: true,
            movementNumber: true,
            type: true,
            movementDate: true,
            quantity: true,
            unitCost: true,
            totalCost: true,
            balanceAfter: true,
            referenceType: true,
            referenceId: true,
            batchNumber: true,
            notes: true,
          },
          // Ordered the way a card is read: oldest first, so the balance column
          // descends the page in the order it actually happened.
          orderBy: [{ movementDate: 'asc' }, { movementNumber: 'asc' }],
          take: MAX_ROWS,
        }),

        tx.stockLevel.findFirst({
          where: { tenantId: context.tenantId, productId, warehouseId },
          select: { quantityOnHand: true, quantityReserved: true, averageCost: true },
        }),

        // The balance carried into the window: the `balanceAfter` of the last
        // movement before it. Cheaper and more truthful than summing the period.
        tx.inventoryMovement.findFirst({
          where: {
            tenantId: context.tenantId,
            productId,
            warehouseId,
            movementDate: { lt: from.value.toDate() },
          },
          select: { balanceAfter: true },
          orderBy: [{ movementDate: 'desc' }, { movementNumber: 'desc' }],
        }),
      ]);

      return { product, warehouse, movements, stockLevel, openingMovement } as const;
    });

    if (card === null) {
      return err(DomainErrors.notFound('الصنف', 'Product', productId));
    }

    if (card.warehouse === null) {
      return err(DomainErrors.notFound('المستودع', 'Warehouse', warehouseId));
    }

    const { product, warehouse, movements, stockLevel, openingMovement } = card;

    const openingBalance = openingMovement?.balanceAfter ?? new Prisma.Decimal(0);

    /**
     * Direction, derived from the balance chain rather than from `type`.
     *
     * `quantity` is always positive — the schema says so explicitly — and `type` only
     * resolves the direction for `IN`, `OUT` and `RETURN`. A `TRANSFER` is inbound at
     * one warehouse and outbound at the other, and an `ADJUSTMENT` goes either way,
     * so reading direction off the type would put a stock count correction in the
     * wrong column half the time.
     *
     * The difference between consecutive `balanceAfter` values is unambiguous, and it
     * is computed in `Decimal` rather than `number` because a quantity at scale 4 is
     * exactly the kind of value floating point rounds.
     */
    let previous = openingBalance;
    const directed = movements.map((movement) => {
      const delta = movement.balanceAfter.minus(previous);
      previous = movement.balanceAfter;

      return {
        ...movement,
        direction: delta.isNegative() ? ('OUT' as const) : ('IN' as const),
        delta: delta.abs().toString(),
      };
    });

    return ok({
      product: {
        id: product.id,
        sku: product.sku,
        nameAr: product.nameAr,
        nameEn: product.nameEn,
        costingMethod: product.costingMethod,
        unitCode: product.unitOfMeasure.code,
        unitNameAr: product.unitOfMeasure.nameAr,
      },
      warehouse,
      period: { from: from.value.toString(), to: to.value.toString() },
      openingBalance: openingBalance.toString(),
      movements: directed.map((movement) => ({
        ...movement,
        quantity: movement.quantity.toString(),
        unitCost: movement.unitCost.toString(),
        totalCost: movement.totalCost.toString(),
        balanceAfter: movement.balanceAfter.toString(),
      })),
      // `truncated` rather than a page number: a card is read top to bottom, and a
      // silently clipped history is worse than one that says it was clipped.
      truncated: movements.length === MAX_ROWS,
      current: {
        quantityOnHand: (stockLevel?.quantityOnHand ?? 0).toString(),
        quantityReserved: (stockLevel?.quantityReserved ?? 0).toString(),
        averageCost: (stockLevel?.averageCost ?? 0).toString(),
      },
    });
  },
  { permission: { resource: 'inventory.movement', action: 'read' } },
);
