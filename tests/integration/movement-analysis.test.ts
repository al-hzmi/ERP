import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getMovementAnalysis, getSlowMovingStock } from '@/lib/application/services/report-service';

/**
 * Movement analysis and slow-moving stock, against real movements.
 *
 * ## The bug these exist for
 *
 * `MovementType` is `IN | OUT | TRANSFER | ADJUSTMENT | RETURN`, and `quantity` is always
 * positive — direction is carried by the type. Except that `ADJUSTMENT` is written for *both*
 * directions and `TRANSFER` covers both legs, so a `CASE` on `type` has to guess on exactly the
 * movements a stock report exists to explain.
 *
 * The report therefore derives the signed delta from `balanceAfter`, the running on-hand
 * balance. That is exact — but only under the order the balances were actually written in, and
 * the obvious ordering is wrong: `createdAt` defaults to `now()`, which PostgreSQL evaluates at
 * *transaction start*, so every movement written by one transaction shares a timestamp and the
 * uuid tiebreak shuffles them. Against the seed that put 131 of 392 positions out.
 *
 * So the load-bearing test here is the last one: every position's summed delta must reproduce
 * `stock_levels.quantityOnHand`. It fails on the plausible-looking ordering and passes on the
 * correct one, which is the only reason it is worth having.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';
let branchId = '';
let warehouseId = '';
let productId = '';
let idleProductId = '';
let sequence = 0;

/**
 * Writes a movement the way the services do: a positive quantity, a type, and the resulting
 * balance. Numbered from a counter so the write order is recoverable, exactly as
 * `erp_next_document_number` makes it in production.
 */
async function movement(input: {
  type: 'IN' | 'OUT' | 'TRANSFER' | 'ADJUSTMENT' | 'RETURN';
  quantity: string;
  balanceAfter: string;
  unitCost: string;
  date: string;
  productId?: string;
}): Promise<void> {
  sequence += 1;
  const number = `MOV-2026-${String(sequence).padStart(6, '0')}`;

  await prisma.inventoryMovement.create({
    data: {
      tenantId,
      movementNumber: number,
      type: input.type,
      movementDate: new Date(`${input.date}T00:00:00.000Z`),
      productId: input.productId ?? productId,
      warehouseId,
      branchId,
      quantity: input.quantity,
      unitCost: input.unitCost,
      totalCost: (Number(input.quantity) * Number(input.unitCost)).toFixed(4),
      balanceAfter: input.balanceAfter,
      createdById: userId,
    },
  });
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('movement analysis', () => {
  beforeEach(async () => {
    sequence = 0;
    const code = `MOV_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'حركة', nameEn: 'Movement' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'keeper',
        email: `keeper@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'أمين',
        fullNameEn: 'Keeper',
      },
      select: { id: true },
    });
    userId = user.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const warehouse = await prisma.warehouse.create({
      data: { tenantId, branchId, code: 'WH1', nameAr: 'الرئيسي', nameEn: 'Main' },
      select: { id: true },
    });
    warehouseId = warehouse.id;

    const [category, uom] = await Promise.all([
      prisma.category.create({
        data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
        select: { id: true },
      }),
      prisma.unitOfMeasure.create({
        data: { tenantId, code: 'EA', nameAr: 'حبة', nameEn: 'Each' },
        select: { id: true },
      }),
    ]);

    const make = async (sku: string): Promise<string> => {
      const created = await prisma.product.create({
        data: {
          tenantId,
          sku,
          nameAr: `صنف ${sku}`,
          nameEn: sku,
          categoryId: category.id,
          unitOfMeasureId: uom.id,
          salePrice: '100.0000',
          costPrice: '60.0000',
        },
        select: { id: true },
      });
      return created.id;
    };

    productId = await make('SKU-MOVE');
    idleProductId = await make('SKU-IDLE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('classifies an ADJUSTMENT in both directions, which its type cannot express', async () => {
    // Two adjustments carrying the same type and both a positive quantity. Anything keying on
    // `type` reports 30 in and 0 out; the balances say otherwise.
    await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-03-01' });
    await movement({ type: 'ADJUSTMENT', quantity: '20', balanceAfter: '120', unitCost: '10', date: '2026-03-05' });
    await movement({ type: 'ADJUSTMENT', quantity: '10', balanceAfter: '110', unitCost: '10', date: '2026-03-06' });

    const [row] = await getMovementAnalysis({
      tenantId,
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-31T00:00:00.000Z'),
      currency: 'SAR',
    });

    // Compared numerically: these come back at the column's scale ('120.0000'), and pinning
    // the string would be testing PostgreSQL's formatting rather than the report.
    expect(Number(row?.quantityIn)).toBe(120);
    expect(Number(row?.quantityOut)).toBe(10);
    expect(Number(row?.netQuantity)).toBe(110);
    expect(row?.movementCount).toBe(3);
  });

  it('does not attribute the opening balance to the period', async () => {
    // The movement before the window is what the first one inside it is measured against. A
    // window computed after filtering would see no predecessor and report 100 as inbound.
    await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-02-01' });
    await movement({ type: 'OUT', quantity: '30', balanceAfter: '70', unitCost: '10', date: '2026-03-10' });

    const [row] = await getMovementAnalysis({
      tenantId,
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-31T00:00:00.000Z'),
      currency: 'SAR',
    });

    expect(Number(row?.quantityIn)).toBe(0);
    expect(Number(row?.quantityOut)).toBe(30);
    expect(Number(row?.netQuantity)).toBe(-30);
  });

  it('values each direction at the movement cost', async () => {
    await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-03-01' });
    await movement({ type: 'OUT', quantity: '40', balanceAfter: '60', unitCost: '12', date: '2026-03-10' });

    const [row] = await getMovementAnalysis({
      tenantId,
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-31T00:00:00.000Z'),
      currency: 'SAR',
    });

    expect(Number(row?.valueIn)).toBe(1000);
    expect(Number(row?.valueOut)).toBe(480);
  });

  it('reproduces the on-hand balance from the summed deltas', async () => {
    // The property the whole approach rests on, and the one the wrong ordering broke. Every
    // movement type appears, including the ambiguous ones.
    await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-03-01' });
    await movement({ type: 'OUT', quantity: '25', balanceAfter: '75', unitCost: '10', date: '2026-03-02' });
    await movement({ type: 'ADJUSTMENT', quantity: '5', balanceAfter: '70', unitCost: '10', date: '2026-03-03' });
    await movement({ type: 'RETURN', quantity: '15', balanceAfter: '85', unitCost: '10', date: '2026-03-04' });
    await movement({ type: 'TRANSFER', quantity: '35', balanceAfter: '50', unitCost: '10', date: '2026-03-05' });
    await movement({ type: 'ADJUSTMENT', quantity: '8', balanceAfter: '58', unitCost: '10', date: '2026-03-06' });

    await prisma.stockLevel.create({
      data: {
        tenantId,
        productId,
        warehouseId,
        quantityOnHand: '58',
        averageCost: '10.0000',
        totalValue: '580.0000',
      },
    });

    const [row] = await getMovementAnalysis({
      tenantId,
      fromDate: new Date('2026-01-01T00:00:00.000Z'),
      toDate: new Date('2026-12-31T00:00:00.000Z'),
      currency: 'SAR',
    });

    const level = await prisma.stockLevel.findFirstOrThrow({
      where: { tenantId, productId, warehouseId },
      select: { quantityOnHand: true },
    });

    expect(Number(row?.netQuantity)).toBe(Number(level.quantityOnHand));
    expect(Number(row?.netQuantity)).toBe(58);
  });

  describe('slow-moving stock', () => {
    it('includes a product that has never been issued at all', async () => {
      // The strongest finding on the report, and the one a plain `last_issue < cutoff` drops:
      // NULL fails every comparison, so the never-sold products would be the ones missing.
      await prisma.stockLevel.create({
        data: {
          tenantId,
          productId: idleProductId,
          warehouseId,
          quantityOnHand: '40',
          averageCost: '25.0000',
          totalValue: '1000.0000',
        },
      });

      const rows = await getSlowMovingStock({
        tenantId,
        asOf: new Date('2026-06-30T00:00:00.000Z'),
        thresholdDays: 30,
        currency: 'SAR',
      });

      const idle = rows.find((row) => row.sku === 'SKU-IDLE');
      expect(idle).toBeDefined();
      expect(idle?.lastIssueDate).toBeNull();
      // Not a large number standing in for "never" — the screen says "لم يُصرف مطلقاً".
      expect(idle?.daysSinceIssue).toBeNull();
    });

    it('excludes a product issued inside the window', async () => {
      await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-06-01' });
      await movement({ type: 'OUT', quantity: '10', balanceAfter: '90', unitCost: '10', date: '2026-06-20' });

      await prisma.stockLevel.create({
        data: {
          tenantId,
          productId,
          warehouseId,
          quantityOnHand: '90',
          averageCost: '10.0000',
          totalValue: '900.0000',
        },
      });

      const rows = await getSlowMovingStock({
        tenantId,
        asOf: new Date('2026-06-30T00:00:00.000Z'),
        thresholdDays: 30,
        currency: 'SAR',
      });

      expect(rows.find((row) => row.sku === 'SKU-MOVE')).toBeUndefined();
    });

    it('includes a product whose last issue predates the threshold', async () => {
      await movement({ type: 'IN', quantity: '100', balanceAfter: '100', unitCost: '10', date: '2026-01-01' });
      await movement({ type: 'OUT', quantity: '10', balanceAfter: '90', unitCost: '10', date: '2026-01-15' });

      await prisma.stockLevel.create({
        data: {
          tenantId,
          productId,
          warehouseId,
          quantityOnHand: '90',
          averageCost: '10.0000',
          totalValue: '900.0000',
        },
      });

      const rows = await getSlowMovingStock({
        tenantId,
        asOf: new Date('2026-06-30T00:00:00.000Z'),
        thresholdDays: 30,
        currency: 'SAR',
      });

      const stale = rows.find((row) => row.sku === 'SKU-MOVE');
      expect(stale?.lastIssueDate).toBe('2026-01-15');
      expect(stale?.daysSinceIssue).toBe(166);
    });

    it('leaves out positions with no stock on hand', async () => {
      // A product with nothing on the shelf is not slow-moving, it is simply absent.
      await prisma.stockLevel.create({
        data: {
          tenantId,
          productId: idleProductId,
          warehouseId,
          quantityOnHand: '0',
          averageCost: '25.0000',
          totalValue: '0.0000',
        },
      });

      const rows = await getSlowMovingStock({
        tenantId,
        asOf: new Date('2026-06-30T00:00:00.000Z'),
        thresholdDays: 30,
        currency: 'SAR',
      });

      expect(rows.find((row) => row.sku === 'SKU-IDLE')).toBeUndefined();
    });
  });
});
