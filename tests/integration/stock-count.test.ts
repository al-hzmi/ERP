import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelStockCount,
  finaliseStockCount,
  getStockCount,
  openStockCount,
  recordCountedQuantities,
} from '@/lib/application/services/stock-count-service';

/**
 * Physical stock counts, against a real database.
 *
 * The property this whole feature exists to protect is that a variance means something: it is
 * the difference between what was on the shelf and what the system believed **at the instant
 * counting began**. So the tests that matter are the ones that move stock *after* the sheet is
 * opened and assert the expected quantity did not follow it — because the naive implementation
 * passes every other test here and fails those.
 *
 * The rest are the refusals: a second open sheet on one warehouse, editing a finalised sheet,
 * finalising twice, and the distinction between an uncounted line and a counted zero.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';
let branchId = '';
let warehouseId = '';
let otherWarehouseId = '';
let productA = '';
let productB = '';

function audit() {
  return {
    tenantId,
    userId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

/** A stock position, written directly — this suite tests counting, not receiving. */
async function position(input: {
  productId: string;
  warehouseId: string;
  quantity: string;
  cost: string;
}): Promise<void> {
  await prisma.stockLevel.create({
    data: {
      tenantId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      quantityOnHand: input.quantity,
      averageCost: input.cost,
      totalValue: (Number(input.quantity) * Number(input.cost)).toFixed(4),
    },
  });
}

async function product(sku: string, categoryId: string, uomId: string): Promise<string> {
  const created = await prisma.product.create({
    data: {
      tenantId,
      sku,
      nameAr: `صنف ${sku}`,
      nameEn: sku,
      categoryId,
      unitOfMeasureId: uomId,
      salePrice: '100.0000',
      costPrice: '60.0000',
    },
    select: { id: true },
  });
  return created.id;
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('physical stock count', () => {
  beforeEach(async () => {
    const code = `CNT_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'جرد', nameEn: 'Count' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'keeper',
        email: `keeper@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'أمين المستودع',
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

    const [warehouse, other] = await Promise.all([
      prisma.warehouse.create({
        data: { tenantId, branchId, code: 'WH1', nameAr: 'الرئيسي', nameEn: 'Main' },
        select: { id: true },
      }),
      prisma.warehouse.create({
        data: { tenantId, branchId, code: 'WH2', nameAr: 'الفرعي', nameEn: 'Secondary' },
        select: { id: true },
      }),
    ]);
    warehouseId = warehouse.id;
    otherWarehouseId = other.id;

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

    productA = await product('SKU-A', category.id, uom.id);
    productB = await product('SKU-B', category.id, uom.id);

    await position({ productId: productA, warehouseId, quantity: '100', cost: '10.0000' });
    await position({ productId: productB, warehouseId, quantity: '50', cost: '20.0000' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('opening a sheet', () => {
    it('freezes a line for every position in the warehouse', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });

      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.lineCount).toBe(2);

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A');
      expect(lineA?.expectedQuantity).toBe('100');
      expect(lineA?.unitCostAtOpen).toBe('10');
      expect(lineA?.countedQuantity).toBeNull();
    });

    it('does not follow the balance after the sheet is open', async () => {
      // The property the whole feature exists for. A naive implementation compares against
      // `stock_levels` at save time and passes every other test in this file.
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      // A day of sales happens while people are counting.
      await prisma.stockLevel.updateMany({
        where: { tenantId, productId: productA, warehouseId },
        data: { quantityOnHand: '40' },
      });

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');

      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A');
      // 100, not 40. A count of 100 is a match, not a surplus of 60.
      expect(lineA?.expectedQuantity).toBe('100');
    });

    it('refuses a second open sheet for the same warehouse', async () => {
      await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });

      const second = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-31',
      });

      expect(second.ok).toBe(false);
    });

    it('allows a sheet on a different warehouse at the same time', async () => {
      await position({
        productId: productA,
        warehouseId: otherWarehouseId,
        quantity: '5',
        cost: '10.0000',
      });

      await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });

      const other = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId: otherWarehouseId,
        countDate: '2026-07-30',
      });

      expect(other.ok).toBe(true);
    });

    it('refuses a warehouse holding nothing', async () => {
      const empty = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId: otherWarehouseId,
        countDate: '2026-07-30',
      });

      expect(empty.ok).toBe(false);
    });
  });

  describe('the frozen columns', () => {
    it('cannot be rewritten, even by a direct update', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const line = await prisma.stockCountLine.findFirstOrThrow({
        where: { countId: opened.value.countId },
        select: { id: true },
      });

      // Bypassing the service entirely, which is the only version of this test worth having:
      // the freeze has to be a property of the database, not a promise the service keeps.
      await expect(
        prisma.stockCountLine.update({
          where: { id: line.id },
          data: { expectedQuantity: '999' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('recording quantities', () => {
    it('keeps an uncounted line distinct from a counted zero', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');

      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A')!;

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: lineA.id, countedQuantity: '0' }],
      });

      const after = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!after.ok) throw new Error('read failed');

      const countedA = after.value.lines.find((line) => line.sku === 'SKU-A');
      const untouchedB = after.value.lines.find((line) => line.sku === 'SKU-B');

      // An empty shelf is a finding worth 100 units; an untouched line is not a finding at all.
      expect(countedA?.countedQuantity).toBe('0');
      expect(countedA?.variance).toBe('-100');
      expect(untouchedB?.countedQuantity).toBeNull();
      expect(untouchedB?.variance).toBeNull();
      expect(after.value.summary.countedLines).toBe(1);
    });

    it('unsets a line when the quantity is cleared', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');
      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A')!;

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: lineA.id, countedQuantity: '95' }],
      });
      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: lineA.id, countedQuantity: null }],
      });

      const after = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!after.ok) throw new Error('read failed');

      expect(after.value.lines.find((line) => line.sku === 'SKU-A')?.countedQuantity).toBeNull();
      expect(after.value.summary.countedLines).toBe(0);
    });

    it('refuses a line id belonging to another tenant', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const result = await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: randomUUID(), countedQuantity: '10' }],
      });

      // Updates nothing rather than throwing — and reports that nothing was updated.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.updated).toBe(0);
    });
  });

  describe('cancelling', () => {
    it('closes the sheet and posts nothing', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const cancelled = await cancelStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      expect(cancelled.ok).toBe(true);

      const movements = await prisma.inventoryMovement.count({ where: { tenantId } });
      expect(movements).toBe(0);

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      expect(view.ok && view.value.status).toBe('CANCELLED');
    });

    it('frees the warehouse for a new sheet', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      await cancelStockCount({ tenantId, userId, audit: audit(), countId: opened.value.countId });

      const again = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-31',
      });

      expect(again.ok).toBe(true);
    });

    it('refuses to edit a cancelled sheet', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');

      await cancelStockCount({ tenantId, userId, audit: audit(), countId: opened.value.countId });

      const result = await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: view.value.lines[0]!.id, countedQuantity: '5' }],
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('finalising', () => {
    it('refuses a sheet with nothing counted', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const result = await finaliseStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      expect(result.ok).toBe(false);
    });

    it('posts nothing for a line that matched', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');
      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A')!;

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: lineA.id, countedQuantity: '100' }],
      });

      const result = await finaliseStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A match is the desired outcome, not an event.
      expect(result.value.adjustmentsPosted).toBe(0);
      expect(result.value.uncountedLines).toBe(1);
    });

    it('leaves uncounted lines untouched', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');
      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A')!;

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: lineA.id, countedQuantity: '100' }],
      });
      await finaliseStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      // SKU-B was never counted. Treating it as zero would have written off 50 units.
      const levelB = await prisma.stockLevel.findFirstOrThrow({
        where: { tenantId, productId: productB, warehouseId },
        select: { quantityOnHand: true },
      });

      expect(levelB.quantityOnHand.toFixed(0)).toBe('50');
    });

    it('refuses to finalise twice', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [{ lineId: view.value.lines[0]!.id, countedQuantity: '100' }],
      });
      await finaliseStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      const again = await finaliseStockCount({
        tenantId,
        userId,
        audit: audit(),
        countId: opened.value.countId,
      });

      expect(again.ok).toBe(false);
    });

    it('summarises shortage and surplus separately', async () => {
      const opened = await openStockCount({
        tenantId,
        userId,
        audit: audit(),
        warehouseId,
        countDate: '2026-07-30',
      });
      if (!opened.ok) throw new Error('open failed');

      const view = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!view.ok) throw new Error('read failed');

      const lineA = view.value.lines.find((line) => line.sku === 'SKU-A')!;
      const lineB = view.value.lines.find((line) => line.sku === 'SKU-B')!;

      await recordCountedQuantities({
        tenantId,
        userId,
        countId: opened.value.countId,
        entries: [
          // 10 short at 10.00 → 100 shortage
          { lineId: lineA.id, countedQuantity: '90' },
          // 5 over at 20.00 → 100 surplus
          { lineId: lineB.id, countedQuantity: '55' },
        ],
      });

      const after = await getStockCount({ tenantId, countId: opened.value.countId });
      if (!after.ok) throw new Error('read failed');

      // Netting them to zero would hide that a hundred of one thing is missing.
      expect(after.value.summary.shortageValue).toBe('100');
      expect(after.value.summary.surplusValue).toBe('100');
      expect(after.value.summary.varianceLines).toBe(2);
    });
  });
});
